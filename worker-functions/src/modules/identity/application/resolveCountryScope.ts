/**
 * src/modules/identity/application/resolveCountryScope.ts
 *
 * Resolvedor de país NO SERVIDOR (PR-9, `lex` #9; contrato
 * `contracts/management-dashboard-country.md`; FR-730…735).
 *
 * Por que existe: `countryScopeGuard.ts` (a "cortesia de UX") é GATED por
 * `COUNTRY_RLS_ENABLED` — em PRD essa flag não existe (o trem ABAC de país
 * ainda não virou lá), e sem ela o guard é no-op. Isto aqui NÃO é gated: é o
 * conserto do FR-732 ("não depende só da RLS") — a decisão de qual país o
 * ator pode ver sai do request, sempre, e vira um predicado explícito nas
 * queries do use case (nunca uma esperança de que a policy do banco esteja
 * ligada).
 *
 * Fonte da verdade: `iam.effective_countries(uid, tenant)` — a MESMA função
 * que a policy RLS (migration 278) e o guard de UX consultam (lex C3/D115):
 * o app nunca afirma os próprios países, sempre pergunta ao banco.
 *
 * Regra (contrato):
 *   requested = 'AR' | 'BR' | 'ALL' (ausente ⇒ 'ALL')
 *   actorCountries = iam.effective_countries(uid, tenant)
 *   actorCountries = []                       → 403 COUNTRY_SCOPE_REQUIRED
 *   requested ∈ {'AR','BR'} ∉ actorCountries   → 403 COUNTRY_SCOPE_REQUIRED
 *   requested ∈ {'AR','BR'} ∈ actorCountries   → scope = [requested]
 *   requested = 'ALL', |actorCountries| = 1    → scope = actorCountries
 *   requested = 'ALL', |actorCountries| > 1    → exige escopo multi-país
 *     concedido com `granted_by`/`reason` documentados (D113) — senão 403
 */

import type { Pool } from 'pg';
import { isCountryCode, type CountryCode } from '@shared/domain/countryCodes';

export type CountryScopeRequested = CountryCode | 'ALL';

export interface CountryScopeResolution {
  /** Países que a consulta deve enxergar — nunca vazio quando a resolução não lançou. */
  countries: CountryCode[];
  /** O que foi pedido (após normalizar ausente/'' para 'ALL'). */
  requested: CountryScopeRequested;
}

export type CountryScopeErrorCode = 'INVALID_COUNTRY' | 'COUNTRY_SCOPE_REQUIRED';

/** Erro tipado — o controller decide o status HTTP a partir de `status`. */
export class CountryScopeError extends Error {
  constructor(
    public readonly status: 400 | 403,
    public readonly code: CountryScopeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CountryScopeError';
  }
}

const EFFECTIVE_COUNTRIES_SQL = `
  SELECT iam.effective_countries($1, iam.current_tenant_id()) AS countries`;

/**
 * "Concedido com granted_by/reason" (D113): NENHUM escopo VIVO de país, em
 * NENHUM grupo VIVO em que o ator está, pode estar sem `reason` documentado
 * (não NULL/vazio). É a versão FORTE de propósito — um ator com AR
 * documentado e BR sem motivo não pode "emprestar" a documentação do AR para
 * destravar o consolidado: `granted_by` é NOT NULL desde a 268 (sempre
 * presente); `reason` ficou opcional na 412 para o caso geral, mas o
 * consolidado multi-país deste dashboard reimpõe a exigência (parecer do
 * `lex`, 11/09) por cima do padrão — TODO grant que compõe a união precisa
 * estar documentado, não só algum.
 */
const DOCUMENTED_MULTI_COUNTRY_GRANT_SQL = `
  SELECT NOT EXISTS (
    SELECT 1
      FROM iam.user_groups ug
      JOIN iam.permission_groups g
        ON g.id = ug.group_id
       AND g.tenant_id = iam.current_tenant_id()
       AND g.archived_at IS NULL
      JOIN iam.group_country_scopes gcs
        ON gcs.group_id = g.id
       AND gcs.revoked_at IS NULL
     WHERE ug.user_id = $1
       AND ug.removed_at IS NULL
       AND (gcs.granted_by IS NULL OR NULLIF(btrim(gcs.reason), '') IS NULL)
  ) AS documented`;

async function actorEffectiveCountries(db: Pool, uid: string): Promise<CountryCode[]> {
  const { rows } = await db.query<{ countries: CountryCode[] | null }>(EFFECTIVE_COUNTRIES_SQL, [uid]);
  return rows[0]?.countries ?? [];
}

async function hasDocumentedMultiCountryGrant(db: Pool, uid: string): Promise<boolean> {
  const { rows } = await db.query<{ documented: boolean | null }>(DOCUMENTED_MULTI_COUNTRY_GRANT_SQL, [uid]);
  return rows[0]?.documented === true;
}

function normalizeRequested(raw: unknown): CountryScopeRequested {
  if (raw === undefined || raw === null || raw === '' || raw === 'ALL') return 'ALL';
  if (isCountryCode(raw)) return raw;
  throw new CountryScopeError(400, 'INVALID_COUNTRY', 'country deve ser AR, BR ou ALL.');
}

/**
 * Resolve o escopo de país da request. NUNCA gated por `COUNTRY_RLS_ENABLED`
 * nem `PERMISSION_ENGINE_ENABLED` (L9-3) — roda sempre, para todo staff.
 *
 * @param db pool/client injetado (nunca o singleton — mesmo padrão de
 *   `hasLiveCountryGrant`, para caber em teste com pool mockado).
 * @param uid firebase_uid do staff autenticado. Ausente ⇒ 403 (não há a quem perguntar).
 * @param requestedRaw `req.query.country` cru — validado aqui, nunca antes.
 */
export async function resolveCountryScope(
  db: Pool,
  uid: string | undefined,
  requestedRaw: unknown,
): Promise<CountryScopeResolution> {
  const requested = normalizeRequested(requestedRaw);

  if (!uid) {
    throw new CountryScopeError(403, 'COUNTRY_SCOPE_REQUIRED', 'Sem identidade de staff — sem país a resolver.');
  }

  const actorCountries = await actorEffectiveCountries(db, uid);
  if (actorCountries.length === 0) {
    throw new CountryScopeError(
      403,
      'COUNTRY_SCOPE_REQUIRED',
      'Sua conta não tem país concedido por nenhum grupo. Peça a atribuição a um admin.',
    );
  }

  if (requested !== 'ALL') {
    if (!actorCountries.includes(requested)) {
      throw new CountryScopeError(
        403,
        'COUNTRY_SCOPE_REQUIRED',
        `Fora do escopo do ator: ${requested}. Seus grupos concedem ${actorCountries.join(', ')}.`,
      );
    }
    return { countries: [requested], requested };
  }

  // requested === 'ALL' → união dos países do ator.
  if (actorCountries.length === 1) {
    return { countries: actorCountries, requested: 'ALL' };
  }

  const documented = await hasDocumentedMultiCountryGrant(db, uid);
  if (!documented) {
    throw new CountryScopeError(
      403,
      'COUNTRY_SCOPE_REQUIRED',
      'Consolidado multi-país exige um grupo com escopo concedido e motivo registrado (D113).',
    );
  }
  return { countries: actorCountries, requested: 'ALL' };
}
