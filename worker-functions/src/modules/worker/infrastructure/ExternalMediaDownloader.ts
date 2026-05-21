import * as dns from 'dns';
import pino from 'pino';
import { logger, reportError } from '@shared/logging';
import {
  HostBlockedError,
  FileTooLargeError,
  DownloadError,
} from '../application/IngestDocumentFromUrlUseCase';

type ChildLogger = pino.Logger;

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const DOWNLOAD_TIMEOUT_MS = 15_000;

/**
 * ExternalMediaDownloader
 *
 * Faz download de URL externa com dupla defesa SSRF:
 * (a) Allowlist de hostnames via ALLOWED_MEDIA_HOSTS env var
 * (b) Resolução de IP + rejeição de ranges RFC 1918, link-local, loopback e IPv6 ULA
 *
 * Allowlist VAZIA por padrão = bloqueia tudo (fail-safe).
 * Suporta wildcards simples: *.dominio.com
 */
export interface DownloadResult {
  buffer: Buffer;
  contentType: string;
}

export class ExternalMediaDownloader {
  private readonly allowedHosts: string[];

  constructor() {
    const raw = process.env.ALLOWED_MEDIA_HOSTS ?? '';
    this.allowedHosts = raw
      .split(',')
      .map(h => h.trim())
      .filter(h => h.length > 0);
  }

  async download(url: string): Promise<DownloadResult> {
    const log = logger.child({ url: this.redactQuery(url), component: 'ExternalMediaDownloader' });

    // 1. Parse e validar URL
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new HostBlockedError(`Invalid URL: ${url}`);
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new HostBlockedError(`Protocol not allowed: ${parsed.protocol}`);
    }

    const hostname = parsed.hostname;

    // 2. Verificar allowlist de hostnames
    if (!this.isHostAllowed(hostname)) {
      log.warn({ msg: 'host not in allowlist', hostname });
      throw new HostBlockedError(`Host not in allowlist: ${hostname}`);
    }

    // 3. Resolver IP e verificar ranges bloqueados
    await this.checkIpSafe(hostname, log);

    // 4. Download com timeout e cap de 10MB
    log.info({ msg: 'starting download' });
    return this.fetchWithLimit(url, log);
  }

  private isHostAllowed(hostname: string): boolean {
    if (this.allowedHosts.length === 0) return false;

    for (const pattern of this.allowedHosts) {
      if (pattern.startsWith('*.')) {
        const suffix = pattern.slice(1); // '.dominio.com'
        if (hostname === suffix.slice(1) || hostname.endsWith(suffix)) {
          return true;
        }
      } else if (pattern === hostname) {
        return true;
      }
    }
    return false;
  }

  private async checkIpSafe(hostname: string, log: ChildLogger): Promise<void> {
    let address: string;
    try {
      const result = await dns.promises.lookup(hostname);
      address = result.address;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      log.warn({ msg: 'dns lookup failed', error: e.message });
      throw new HostBlockedError(`DNS resolution failed for ${hostname}: ${e.message}`);
    }

    if (this.isBlockedIp(address)) {
      log.warn({ msg: 'resolved IP is in blocked range', address });
      throw new HostBlockedError(`Resolved IP ${address} is in blocked range (SSRF protection)`);
    }
  }

  /**
   * Verifica se um IP está em ranges bloqueados:
   * - RFC 1918: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
   * - Link-local: 169.254.0.0/16 (inclui GCP metadata 169.254.169.254)
   * - Loopback: 127.0.0.0/8, ::1
   * - IPv6 ULA: fc00::/7
   */
  private isBlockedIp(ip: string): boolean {
    // IPv6
    if (ip.includes(':')) {
      if (ip === '::1') return true;
      // fc00::/7 cobre fc00:: a fdff::
      if (/^f[cd]/i.test(ip)) return true;
      return false;
    }

    // IPv4
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some(n => isNaN(n))) return false;

    const [a, b] = parts;

    if (a === 10) return true;                              // 10.0.0.0/8
    if (a === 127) return true;                             // 127.0.0.0/8
    if (a === 169 && b === 254) return true;                // 169.254.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true;      // 172.16.0.0/12
    if (a === 192 && b === 168) return true;                // 192.168.0.0/16

    return false;
  }

  private async fetchWithLimit(
    url: string,
    log: ChildLogger,
  ): Promise<DownloadResult> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

    try {
      const response = await fetch(url, { signal: controller.signal });

      if (!response.ok) {
        throw new DownloadError(`HTTP ${response.status} from ${this.redactQuery(url)}`);
      }

      const contentType = response.headers.get('content-type') ?? 'application/octet-stream';

      if (!response.body) {
        throw new DownloadError('Response body is null');
      }

      // Ler em chunks com cap de 10MB
      const chunks: Uint8Array[] = [];
      let totalSize = 0;
      const reader = response.body.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        totalSize += value.byteLength;
        if (totalSize > MAX_FILE_SIZE) {
          reader.cancel().catch(() => undefined);
          throw new FileTooLargeError(
            `File exceeds 10MB limit (received ${totalSize} bytes so far)`,
          );
        }
        chunks.push(value);
      }

      const buffer = Buffer.concat(chunks.map(c => Buffer.from(c)));
      log.info({ msg: 'download complete', bytes: buffer.length, contentType });

      return { buffer, contentType };
    } catch (err) {
      if (err instanceof FileTooLargeError || err instanceof HostBlockedError) {
        throw err;
      }
      if (err instanceof DownloadError) {
        throw err;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      if (e.name === 'AbortError') {
        throw new DownloadError(`Download timed out after ${DOWNLOAD_TIMEOUT_MS}ms`);
      }
      reportError(e, { source: 'ExternalMediaDownloader:fetch', url: this.redactQuery(url) });
      throw new DownloadError(`Download failed: ${e.message}`);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private redactQuery(url: string): string {
    try {
      const parsed = new URL(url);
      parsed.search = '';
      return parsed.toString();
    } catch {
      return '[invalid-url]';
    }
  }
}
