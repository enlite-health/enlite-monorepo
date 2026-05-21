/**
 * ExternalMediaDownloader.test.ts
 *
 * Testa a defesa SSRF e o comportamento de download.
 */

import { ExternalMediaDownloader } from '../ExternalMediaDownloader';
import { HostBlockedError, FileTooLargeError } from '../../application/IngestDocumentFromUrlUseCase';

// Mock de logger para não poluir output dos testes
jest.mock('@shared/logging', () => ({
  logger: { child: jest.fn().mockReturnValue({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) },
  reportError: jest.fn(),
}));

// Mock de dns.promises.lookup
jest.mock('dns', () => ({
  promises: {
    lookup: jest.fn(),
  },
}));

import * as dns from 'dns';
const mockLookup = dns.promises.lookup as jest.Mock;

// Mock do fetch global
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('ExternalMediaDownloader', () => {
  describe('Allowlist de hosts', () => {
    it('bloqueia tudo com allowlist vazia (fail-safe)', async () => {
      process.env.ALLOWED_MEDIA_HOSTS = '';
      const d = new ExternalMediaDownloader();

      await expect(d.download('https://example.com/file.pdf')).rejects.toThrow(HostBlockedError);
    });

    it('permite host explícito na allowlist', async () => {
      process.env.ALLOWED_MEDIA_HOSTS = 'example.com';
      mockLookup.mockResolvedValue({ address: '93.184.216.34', family: 4 });
      const stream = makeReadableStream(Buffer.from('hello'));
      mockFetch.mockResolvedValue({
        ok: true,
        headers: { get: () => 'application/pdf' },
        body: stream,
      });

      const d = new ExternalMediaDownloader();
      const result = await d.download('https://example.com/file.pdf');
      expect(result.buffer.toString()).toBe('hello');
    });

    it('permite wildcard *.twilio.com', async () => {
      process.env.ALLOWED_MEDIA_HOSTS = '*.twilio.com';
      mockLookup.mockResolvedValue({ address: '52.0.0.1', family: 4 });
      const stream = makeReadableStream(Buffer.from('data'));
      mockFetch.mockResolvedValue({
        ok: true,
        headers: { get: () => 'image/jpeg' },
        body: stream,
      });

      const d = new ExternalMediaDownloader();
      const result = await d.download('https://media.twilio.com/file.jpg');
      expect(result.contentType).toBe('image/jpeg');
    });

    it('bloqueia host fora da allowlist', async () => {
      process.env.ALLOWED_MEDIA_HOSTS = 'safe.com';
      const d = new ExternalMediaDownloader();

      await expect(d.download('https://evil.com/file.pdf')).rejects.toThrow(HostBlockedError);
    });
  });

  describe('Defesa SSRF por IP', () => {
    beforeEach(() => {
      process.env.ALLOWED_MEDIA_HOSTS = 'safe.com';
    });

    const blockedIPs = [
      { ip: '10.0.0.1', label: 'RFC 1918 10.x' },
      { ip: '172.16.5.5', label: 'RFC 1918 172.16-31.x' },
      { ip: '192.168.1.1', label: 'RFC 1918 192.168.x' },
      { ip: '127.0.0.1', label: 'loopback 127.x' },
      { ip: '169.254.169.254', label: 'GCP metadata server' },
      { ip: '::1', label: 'IPv6 loopback' },
      { ip: 'fc00::1', label: 'IPv6 ULA fc00::/7' },
      { ip: 'fd12:3456:789a:1::1', label: 'IPv6 ULA fd::/8' },
    ];

    test.each(blockedIPs)('bloqueia $label ($ip)', async ({ ip }) => {
      mockLookup.mockResolvedValue({ address: ip, family: ip.includes(':') ? 6 : 4 });
      const d = new ExternalMediaDownloader();

      await expect(d.download('https://safe.com/file.pdf')).rejects.toThrow(HostBlockedError);
    });
  });

  describe('Limite de tamanho', () => {
    it('lança FileTooLargeError quando arquivo > 10MB', async () => {
      process.env.ALLOWED_MEDIA_HOSTS = 'safe.com';
      mockLookup.mockResolvedValue({ address: '52.0.0.1', family: 4 });

      // Simula stream que entrega 11MB em um chunk
      const bigChunk = Buffer.alloc(11 * 1024 * 1024);
      const stream = makeReadableStream(bigChunk);
      mockFetch.mockResolvedValue({
        ok: true,
        headers: { get: () => 'application/pdf' },
        body: stream,
      });

      const d = new ExternalMediaDownloader();
      await expect(d.download('https://safe.com/big.pdf')).rejects.toThrow(FileTooLargeError);
    });
  });
});

// Helper: cria um ReadableStream compatível com o fetch Web API
function makeReadableStream(data: Buffer): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(new Uint8Array(data));
      } else {
        controller.close();
      }
    },
  });
}
