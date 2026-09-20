import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { createHash } from 'node:crypto';
import { parseEnvList } from '@shared/utils/envList';
import { ServicePrincipal } from '../domain/ServicePrincipal';
import { McpPrincipalNotFoundError } from '../domain/McpErrors';
import { logger } from '../../../shared/logging/Logger';

interface CacheEntry {
  principal: ServicePrincipal;
  cachedAt: number;
}

interface SecretPayload {
  name: string;
  allowedCapabilities: string[];
  tokens: string[];
}

export class ServicePrincipalSecretManagerRepo {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;

  constructor(
    private readonly client: SecretManagerServiceClient = new SecretManagerServiceClient(),
    private readonly projectId: string = process.env.GCP_PROJECT_ID ?? '',
    ttlMs: number = 60_000,
  ) {
    this.ttlMs = ttlMs;
  }

  async getByName(principalName: string): Promise<ServicePrincipal> {
    const cached = this.cache.get(principalName);
    if (cached && Date.now() - cached.cachedAt < this.ttlMs) {
      return cached.principal;
    }
    const principal = await this.loadFromSecretManager(principalName);
    this.cache.set(principalName, { principal, cachedAt: Date.now() });
    return principal;
  }

  /**
   * Tenta resolver qual principal corresponde a um token.
   * Faz lookup em todos os principals cacheados; se nenhum bater, recarrega do SM e tenta de novo.
   * Retorna null se nenhum match.
   */
  async findByToken(token: string): Promise<ServicePrincipal | null> {
    const hashFn = (s: string) => createHash('sha256').update(s).digest('hex');

    // Primeira passada: cache
    for (const entry of this.cache.values()) {
      if (Date.now() - entry.cachedAt < this.ttlMs && entry.principal.matchesToken(token, hashFn)) {
        return entry.principal;
      }
    }

    // Se cache miss, recarrega todos os principals conhecidos
    // TD futuro: descobrir principals dinamicamente via prefix do Secret Manager
    const knownPrincipals = parseEnvList(process.env.MCP_PRINCIPAL_NAMES ?? 'triage-service');

    for (const name of knownPrincipals) {
      try {
        const principal = await this.getByName(name);
        if (principal.matchesToken(token, hashFn)) return principal;
      } catch (err) {
        logger.warn(
          { err, principalName: name },
          'mcp: failed to load principal during token lookup',
        );
      }
    }

    return null;
  }

  private async loadFromSecretManager(principalName: string): Promise<ServicePrincipal> {
    const secretId = `mcp-principal-${principalName}`;
    const name = `projects/${this.projectId}/secrets/${secretId}/versions/latest`;
    try {
      const [version] = await this.client.accessSecretVersion({ name });
      const payload = version.payload?.data?.toString();
      if (!payload) throw new McpPrincipalNotFoundError(principalName);
      const parsed = JSON.parse(payload) as SecretPayload;
      const tokenHashes = parsed.tokens.map((t) =>
        createHash('sha256').update(t).digest('hex'),
      );
      return new ServicePrincipal({
        name: parsed.name,
        allowedCapabilities: parsed.allowedCapabilities,
        tokenHashes,
      });
    } catch (err) {
      if (err instanceof McpPrincipalNotFoundError) throw err;
      logger.error({ err, principalName }, 'mcp: failed to load principal from Secret Manager');
      throw new McpPrincipalNotFoundError(principalName);
    }
  }

  /**
   * Limpa cache — chamar em testes ou em flow de rotação operacional.
   */
  invalidate(principalName?: string): void {
    if (principalName) {
      this.cache.delete(principalName);
    } else {
      this.cache.clear();
    }
  }
}
