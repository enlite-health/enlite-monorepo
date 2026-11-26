/**
 * Regras puras do re-teste do vínculo do Tactiq (change tactiq-vinculo-resiliente, D9: este arquivo é o dono do conceito).
 * Sem import de infraestrutura.
 */

/** "Causa assento": o Tactiq recusou por falta de licença (`access_action:request_seat`). Qualquer outra ação (ex.: `upgrade`) não é. */
export function isSeatCause(reason: string | null | undefined): boolean {
  return reason === 'access_action:request_seat';
}

/**
 * `CONSENT_SCOPE_FROZEN` = o consentimento do Tactiq lembra o escopo antigo (P-C2 = não): sem escopo na renovação, vale o último
 * `scope` gravado no vínculo (design D5). `false` = o escopo cresce no revínculo: sem escopo na renovação vale só o `ready`.
 */
// F38 não medida em 25/11 → default true (design D5; fatos-medidos F25)
export const CONSENT_SCOPE_FROZEN: boolean = true;

/** Escopo do Tactiq que dá acesso aos detalhes (transcrição) da reunião. */
export const DETAILS_SCOPE = 'mcp:meetings:details';

/** Causas de queda que um re-teste não conserta: token morto ou 401/403 de transporte (fail closed). */
const DEAD_REASONS: ReadonlySet<string> = new Set(['invalid_grant', 'token_endpoint_401_403', 'mcp_transport_401_403']);

export interface LastDegrade {
  /** `tactiq_link.broken` | `tactiq_link.wrong_account` | `tactiq_link.recheck_dead`. */
  kind: string;
  reason: string | null;
  /** `ref->>'source'`: `import` | `daily_check` | `link`; ausente = queda anterior à change. */
  source?: string | null;
}

export interface RecheckInput {
  status: string;
  lastDegrade: LastDegrade | null;
}

/** Quem o teste diário tenta de novo (design D3). Sem evento de queda, token morto, `recheck_dead` e queda da importação ficam de fora. */
export function isRecheckable({ status, lastDegrade }: RecheckInput): boolean {
  if (status !== 'broken' && status !== 'wrong_account') return false;
  if (!lastDegrade) return false;
  if (lastDegrade.kind === 'tactiq_link.recheck_dead') return false;
  if (lastDegrade.source === 'import') return false;
  const reason = lastDegrade.reason ?? '';
  if (DEAD_REASONS.has(reason)) return false;
  if (status === 'wrong_account') return true;
  if (reason.startsWith('access_action:')) return true;
  if (lastDegrade.source === 'link') return true;
  return reason === 'unauthorized' && (lastDegrade.source == null || lastDegrade.source === 'daily_check');
}

/**
 * O escopo efetivo dá acesso aos detalhes? (design D5) O `scope` da renovação, se vier, é autoritativo. Sem ele: congelado → o último
 * `scope` gravado no vínculo; sem escopo gravado (legado) ou não congelado → "não apurado", vale só o `ready` (devolve `true`).
 */
export function effectiveScopeHasDetails(input: {
  refreshScope: string | null | undefined;
  lastLinkScope: string | null | undefined;
  frozen: boolean;
}): boolean {
  const hasDetails = (scope: string): boolean => scope.split(/\s+/).includes(DETAILS_SCOPE);
  if (typeof input.refreshScope === 'string') return hasDetails(input.refreshScope);
  if (input.frozen && typeof input.lastLinkScope === 'string') return hasDetails(input.lastLinkScope);
  return true;
}
