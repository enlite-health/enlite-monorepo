/**
 * src/modules/identity/permissions/application/PermissionService.ts
 *
 * A implementação da porta de entrada `PermissionClient` — e o único lugar com
 * CACHE. Duas decisões que valem explicação:
 *
 * 1. **Cache curto por uid, não claim no JWT** (design 4). Claim exigiria
 *    `revokeRefreshTokens` e uma janela de 1h para valer — contra o requisito
 *    "vale na próxima request" (spec permission-enforcement) e contra o achado
 *    do #221 (claim é frágil). Aqui a janela é o TTL (30s default,
 *    `PERMISSION_CACHE_TTL_MS`, 0 no e2e) e some quase inteira com a
 *    invalidação por evento.
 * 2. **Disponibilidade de feature cai no MANIFEST quando o banco não tem
 *    linha.** O manifest é o default declarado em código; tratar "linha
 *    ausente" como indisponível transformaria um sync que não rodou em blecaute
 *    de painel. Chave que não existe nem no manifest → indisponível: essa sim é
 *    desconhecida, e desconhecido é fail-closed.
 */

import { logger } from '@shared/logging';
import type { CountryCode } from '@shared/domain/countryCodes';
import { cellKey } from '../domain/PermissionCell';
import type {
  CountryFeatureRepository,
  EffectiveAuthzRepository,
  PermissionClient,
  ResolvedAuthz,
} from './ports';
import {
  COUNTRY_FEATURES_MANIFEST,
  manifestDefault,
  type CountryFeatureManifest,
} from '../infrastructure/country-features.manifest';

/**
 * ⚠️ Duplicação de PADRÃO consciente: `MessagingChannelPauseCache`
 * (`@modules/notification`) tem a mesma forma — `Map<chave, {valor, expiresAt}>`
 * + `invalidate(chave?)`. Não é reusada de propósito: importar outro módulo de
 * domínio aqui quebra o teste de fronteira (task 2.1) e desfaz a extração para o
 * permission-service (D115 §7). Extrair um `TtlCache` genérico para `@shared`
 * resolveria — mas obrigaria a mexer no cache de mensageria, fora do escopo
 * desta change; fica anotado como candidato quando alguém precisar do terceiro.
 */
export const DEFAULT_PERMISSION_CACHE_TTL_MS = 30_000;
/** Teto de entradas — o painel tem dezenas de staff, não milhares; é só um freio. */
const MAX_CACHE_ENTRIES = 2_000;

/** TTL do ambiente (lex C9: por ambiente, documentado). `0` desliga o cache. */
export function permissionCacheTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PERMISSION_CACHE_TTL_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_PERMISSION_CACHE_TTL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    logger.warn({ raw }, '[perm] PERMISSION_CACHE_TTL_MS inválido — usando o default');
    return DEFAULT_PERMISSION_CACHE_TTL_MS;
  }
  return parsed;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface PermissionServiceOptions {
  ttlMs?: number;
  manifest?: CountryFeatureManifest;
  /** Injetável para o teste medir a janela sem esperar o relógio. */
  now?: () => number;
}

/** country → featureKey → estado (o formato que `/v1/me/authz` devolve). */
export type FeaturesByCountry = Record<string, Record<string, { enabled: boolean; config: unknown }>>;

export class PermissionService implements PermissionClient {
  private readonly ttlMs: number;
  private readonly manifest: CountryFeatureManifest;
  private readonly now: () => number;
  private readonly authzCache = new Map<string, CacheEntry<ResolvedAuthz>>();
  private featuresCache?: CacheEntry<FeaturesByCountry>;

  constructor(
    private readonly authzRepository: EffectiveAuthzRepository,
    private readonly featureRepository: CountryFeatureRepository,
    options: PermissionServiceOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? permissionCacheTtlMs();
    this.manifest = options.manifest ?? COUNTRY_FEATURES_MANIFEST;
    this.now = options.now ?? (() => Date.now());
  }

  async resolve(uid: string, tenantId: string): Promise<ResolvedAuthz> {
    const key = `${tenantId}:${uid}`;
    const cached = this.authzCache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.value;

    const resolved = await this.authzRepository.snapshot(uid, tenantId);
    if (this.ttlMs > 0) {
      if (this.authzCache.size >= MAX_CACHE_ENTRIES) this.evictOldest();
      this.authzCache.set(key, { value: resolved, expiresAt: this.now() + this.ttlMs });
    }
    return resolved;
  }

  /**
   * Decisão por célula. Conta não-ACTIVE é negada ANTES de olhar grupos (spec) —
   * o banco já filtra por status, mas a checagem explícita é o que permite dizer
   * "conta em admissão" em vez de "sem permissão" na tela.
   */
  async can(uid: string, tenantId: string, resource: string, action: string): Promise<boolean> {
    const resolved = await this.resolve(uid, tenantId);
    if (resolved.status !== 'ACTIVE') return false;
    return resolved.permissions.includes(cellKey(resource, action));
  }

  async isFeatureAvailable(country: CountryCode, featureKey: string): Promise<boolean> {
    const stored = (await this.features())[country]?.[featureKey];
    if (stored) return stored.enabled;
    return manifestDefault(country, featureKey, this.manifest)?.enabled ?? false;
  }

  async featureConfig(country: CountryCode, featureKey: string): Promise<unknown> {
    const stored = (await this.features())[country]?.[featureKey];
    if (stored) return stored.config ?? null;
    return manifestDefault(country, featureKey, this.manifest)?.config ?? null;
  }

  /** Disponibilidade por país (banco por cima do manifest) — usada por `/v1/me/authz`. */
  async features(): Promise<FeaturesByCountry> {
    if (this.featuresCache && this.featuresCache.expiresAt > this.now()) return this.featuresCache.value;

    const byCountry: FeaturesByCountry = {};
    for (const [featureKey, entry] of Object.entries(this.manifest)) {
      for (const [country, value] of Object.entries(entry)) {
        if (!value) continue;
        byCountry[country] ??= {};
        byCountry[country][featureKey] = { enabled: value.enabled, config: value.config ?? null };
      }
    }
    for (const row of await this.featureRepository.list()) {
      byCountry[row.country] ??= {};
      byCountry[row.country][row.featureKey] = { enabled: row.enabled, config: row.config ?? null };
    }

    if (this.ttlMs > 0) this.featuresCache = { value: byCountry, expiresAt: this.now() + this.ttlMs };
    return byCountry;
  }

  /** Sem uids = limpa tudo (inclusive features) — é o que o handler do evento chama. */
  invalidate(uids?: string[]): void {
    if (!uids) {
      this.authzCache.clear();
      this.featuresCache = undefined;
      return;
    }
    for (const key of [...this.authzCache.keys()]) {
      if (uids.some((uid) => key.endsWith(`:${uid}`))) this.authzCache.delete(key);
    }
  }

  /** Só a disponibilidade por país — evento de feature não mexe em permissão. */
  invalidateFeatures(): void {
    this.featuresCache = undefined;
  }

  private evictOldest(): void {
    const oldest = this.authzCache.keys().next();
    if (!oldest.done) this.authzCache.delete(oldest.value);
  }
}
