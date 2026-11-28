import { createHash } from 'crypto';
import { GoogleAuth } from 'google-auth-library';

// =====================
// GoogleApiKeyValidator — valida GCP API Keys via Google API (lookupKey)
//
// Fluxo:
//   1. Recebe a API Key raw do header X-Partner-Key
//   2. Chama GET apikeys.googleapis.com/v2/keys:lookupKey?keyString=<key>
//      → retorna apenas { name: "projects/.../keys/xxx" }
//   3. Chama GET apikeys.googleapis.com/v2/{name}
//      → retorna os detalhes incluindo displayName
//   4. Cache em memória (spec 095 §3.2 item 6):
//      - TTL 6 h. Entrada com mais de 1 h: devolve o cache e renova FORA do caminho da resposta (sem await).
//      - stale-on-error: erro transitório (não 400/403/404) com entrada de até 24 h → devolve o último
//        displayName bom e loga `partner_key_validation_stale`. Antes, uma falha transitória virava 401,
//        que o Talentum nunca reenvia (F8).
//      - 400/403/404 → apaga a entrada e devolve null: chave revogada continua sendo recusada.
//
// Nunca logar a chave (nem prefixo) nem a mensagem do erro (a URL da chamada leva a chave).
// Em modo teste (USE_MOCK_AUTH=true), retorna displayName mock.
// =====================

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 h
const REFRESH_AFTER_MS = 60 * 60 * 1000; // 1 h: acima disso renova em background
const STALE_MAX_MS = 24 * 60 * 60 * 1000; // 24 h: teto do stale-on-error
const LOOKUP_URL = 'https://apikeys.googleapis.com/v2/keys:lookupKey';
const KEYS_BASE_URL = 'https://apikeys.googleapis.com/v2';

interface CacheEntry {
  displayName: string;
  cachedAt: number;
}

/** Resultado definitivo da API de chaves: erro transitório NÃO entra aqui (lança). */
type LookupResult = { displayName: string } | { rejected: true };

export class GoogleApiKeyValidator {
  private cache = new Map<string, CacheEntry>();
  private refreshing = new Set<string>();
  private auth: GoogleAuth;

  constructor() {
    this.auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
  }

  /**
   * Valida uma GCP API Key e retorna o displayName.
   * Retorna null se a key for inválida ou revogada.
   */
  async validate(apiKey: string): Promise<string | null> {
    // Bypass para testes E2E
    if (process.env.USE_MOCK_AUTH === 'true') {
      return 'mock-partner-key';
    }

    // Cache lookup (usa hash da key como chave — não guarda key raw em memória)
    const cacheKey = this.hashKey(apiKey);
    const cached = this.cache.get(cacheKey);
    const age = cached ? Date.now() - cached.cachedAt : Infinity;

    if (cached && age < CACHE_TTL_MS) {
      if (age >= REFRESH_AFTER_MS) this.refreshInBackground(cacheKey, apiKey);
      return cached.displayName;
    }

    try {
      const result = await this.lookup(apiKey);
      if ('rejected' in result) {
        this.cache.delete(cacheKey);
        return null;
      }
      this.cache.set(cacheKey, { displayName: result.displayName, cachedAt: Date.now() });
      return result.displayName;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 400 || status === 403 || status === 404) {
        // key inválida ou sem permissão: derruba o cache (revogada continua recusada)
        console.warn(`[GoogleApiKeyValidator] Key rejeitada (HTTP ${status})`);
        this.cache.delete(cacheKey);
        return null;
      }
      if (cached && age <= STALE_MAX_MS) {
        console.warn(`[GoogleApiKeyValidator] partner_key_validation_stale | status=${status ?? 'none'} | age_min=${Math.round(age / 60000)}`);
        return cached.displayName;
      }
      console.error(`[GoogleApiKeyValidator] Erro ao validar key (transitório) | status=${status ?? 'none'}`);
      return null;
    }
  }

  /** Chama a API de chaves. Rejeição definitiva → `{ rejected }`; erro transitório ou 400/403/404 → lança. */
  private async lookup(apiKey: string): Promise<LookupResult> {
    const client = await this.auth.getClient();

    // Passo 1: lookupKey → obtém o resource name da key
    const lookupResponse = await client.request<{ name: string }>({
      url: `${LOOKUP_URL}?keyString=${encodeURIComponent(apiKey)}`,
      method: 'GET',
    });

    const keyName = lookupResponse.data?.name;
    if (!keyName) {
      console.warn('[GoogleApiKeyValidator] lookupKey não retornou name');
      return { rejected: true };
    }

    // Passo 2: busca detalhes da key pelo resource name → obtém displayName
    const detailResponse = await client.request<{ name: string; displayName: string }>({
      url: `${KEYS_BASE_URL}/${keyName}`,
      method: 'GET',
    });

    const displayName = detailResponse.data?.displayName;
    if (!displayName) {
      console.warn('[GoogleApiKeyValidator] Key sem displayName configurado');
      return { rejected: true };
    }
    return { displayName };
  }

  /**
   * Renova a entrada SEM await (fora do caminho da resposta). Nunca rejeita: o erro é guardado em log
   * (só o status, nunca a chave). 400/403/404 apagam a entrada; erro transitório mantém a entrada.
   */
  private refreshInBackground(cacheKey: string, apiKey: string): void {
    if (this.refreshing.has(cacheKey)) return;
    this.refreshing.add(cacheKey);
    this.lookup(apiKey)
      .then((result) => {
        if ('rejected' in result) this.cache.delete(cacheKey);
        else this.cache.set(cacheKey, { displayName: result.displayName, cachedAt: Date.now() });
      })
      .catch((err: any) => {
        const status = err?.response?.status;
        if (status === 400 || status === 403 || status === 404) {
          console.warn(`[GoogleApiKeyValidator] Key rejeitada no refresh (HTTP ${status})`);
          this.cache.delete(cacheKey);
        } else {
          console.warn(`[GoogleApiKeyValidator] Refresh em background falhou (transitório) | status=${status ?? 'none'}`);
        }
      })
      .catch(() => undefined)
      .finally(() => this.refreshing.delete(cacheKey));
  }

  /**
   * Limpa o cache (útil para testes)
   */
  clearCache(): void {
    this.cache.clear();
  }

  private hashKey(apiKey: string): string {
    return createHash('sha256').update(apiKey).digest('hex');
  }
}
