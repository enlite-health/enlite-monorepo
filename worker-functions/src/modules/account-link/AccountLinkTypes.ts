/**
 * AccountLinkTypes — contrato v2 do vínculo self-service por colisão de telefone.
 * (openspec: vinculo-contas-colisao-telefone, emenda 04/08: lookup≠OTP; valores
 * de conflito só DEPOIS da posse provada.)
 */

import type { FieldComparison } from '../../application/dedup/DedupTypes';

// ── Códigos de erro estáveis (o front trata por código, nunca por mensagem) ──

export const ACCOUNT_LINK_ERRORS = {
  NO_CONFLICT: 'NO_CONFLICT',           // telefone livre (ou já é da conta logada)
  USE_CLAIM: 'USE_CLAIM',               // dona é ficha importada → fluxo de claim existente
  RATE_LIMITED: 'RATE_LIMITED',         // 3 starts/h por conta estourado
  INVALID_OTP: 'INVALID_OTP',
  EXPIRED_OTP: 'EXPIRED_OTP',
  INVALID_LINK_TOKEN: 'INVALID_LINK_TOKEN',
  WORKER_NOT_FOUND: 'WORKER_NOT_FOUND',
} as const;

export type AccountLinkErrorCode = keyof typeof ACCOUNT_LINK_ERRORS;

export class AccountLinkError extends Error {
  constructor(
    readonly code: AccountLinkErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'AccountLinkError';
  }
}

// ── Shapes de resposta ─────────────────────────────────────────────────────

/** POST lookup — SEM SMS, SÓ mascarados (nada decriptado antes da posse). */
export interface AccountLinkLookupResult {
  otherEmailMasked: string;
  phoneMasked: string;
}

/** POST start — dispara o OTP pro número DA CONTA ANTIGA. */
export interface AccountLinkStartResult {
  verificationSid: string;
  phoneMasked: string;
}

/** Conflito exposto ao worker (subset público + sugestão = mais recente). */
export interface AccountLinkConflict extends FieldComparison {
  /** Account id sugerido (conta com updated_at mais recente). */
  suggested: string;
}

/** POST confirm / finalize. */
export type AccountLinkConfirmResult =
  | { status: 'merged'; recovered: Record<string, number>; workerStatus: string | null }
  | { status: 'conflicts'; conflicts: AccountLinkConflict[]; linkToken: string; accounts: { current: string; other: string } }
  | { status: 'REQUIRES_REVIEW' };

// ── Campos que o worker compara/escolhe no self-service ────────────────────
// Subset PÚBLICO de OVERRIDABLE_FIELDS (ExecuteAdminMergeUseCase): PII
// encriptada fica fora do chooser do worker no v1 — o coalesce/move do merge
// resolve; conflito de PII real cai no atendimento humano.

export const WORKER_COMPARE_FIELDS = [
  'profession',
  'knowledge_level',
  'years_experience',
] as const;

// ── Degrau de alto valor ───────────────────────────────────────────────────
// WJA em estágio "entrevista ou além" (proposta): CONFIRMED (slot de encuadre
// confirmado) e SELECTED (selecionado). REJECTED/funil inicial não seguram.

export const HIGH_VALUE_WJA_STAGES = ['CONFIRMED', 'SELECTED'] as const;
