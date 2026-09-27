import { REJECTION_REASON_CATEGORIES } from './Encuadre';
import { boardPosition } from './kanbanColumn';

/**
 * Motivo do arrasto no quadro B (funil de candidatura) que pula etapa, entra em
 * Rejeitados ou sai de Rejeitados — Fase 4 (D430/D434, invariante 11). A regra mora
 * SÓ aqui: `WJAFunnelController.moveEncuadre` (P8) só chama `requiredMoveReason` e
 * `isAllowedMoveReason`, nunca reimplementa "o que é salto" (DX-4.6,
 * execucao/fase-4.md). O front (`FE/domain/entities/MoveReason.ts`) só espelha o
 * CATÁLOGO de rótulo — a regra de exigir motivo é sempre da API.
 */

/** Motivos de "salto de etapa" — mais de uma posição à frente no quadro B (DX-4.4). */
export const JUMP_REASONS = [
  'ENCUADRE_ANTECIPADO',
  'REAPROVEITADO_DE_OUTRA_VAGA',
  'INDICACAO_DA_EQUIPE',
  'OTHER',
] as const;

/** Motivos de sair de Rejeitados para outra etapa (DX-4.4). */
export const LEAVE_REJECTED_REASONS = ['REAVALIACAO', 'REJEITADO_POR_ENGANO', 'OTHER'] as const;

export type MoveReasonKind = 'JUMP' | 'ENTER_REJECTED' | 'LEAVE_REJECTED';

/**
 * Categorias válidas por tipo de motivo. `ENTER_REJECTED` REUSA
 * `REJECTION_REASON_CATEGORIES` (Encuadre.ts) — não copia a lista de rejeição
 * (DX-4.4: "OUTRO" vira "OTHER" justamente para não ter as duas na mesma coluna).
 */
export const MOVE_REASONS_BY_KIND: Record<MoveReasonKind, readonly string[]> = {
  JUMP: JUMP_REASONS,
  ENTER_REJECTED: REJECTION_REASON_CATEGORIES,
  LEAVE_REJECTED: LEAVE_REJECTED_REASONS,
};

/**
 * União sem repetição das três listas acima — é o CHECK `wjash_reason_category_check`
 * da migration 478 (`MIG/478_stage_history_reason_category.sql`), 14 valores
 * (`OTHER` uma vez). O teste unitário confere a igualdade contra o literal do CHECK,
 * escrito à mão: se alguém mudar uma lista aqui sem migration, ele quebra.
 */
export const ALL_MOVE_REASONS: readonly string[] = Array.from(
  new Set<string>([...JUMP_REASONS, ...REJECTION_REASON_CATEGORIES, ...LEAVE_REJECTED_REASONS]),
);

/**
 * Etapa, fonte e envio da candidatura ANTES do arrasto. `null` = nunca houve candidatura
 * para essa vaga. `messagedAt` é obrigatório (Fase 5, DX-5.1): sem ele a origem não sabe
 * se o card está em Compatíveis (candidato do match nunca mensageado) ou em Invitados.
 */
export interface MoveOrigin {
  stage: string | null;
  source: string | null;
  messagedAt: string | Date | null;
}

/** O id da coluna derivada Compatíveis (Fase 5, D432) — NÃO é valor de `application_funnel_stage`. */
export const COMPATIBLE_COLUMN = 'COMPATIBLE' as const;

/**
 * Por que o arrasto envolvendo Compatíveis é recusado (422 `COMPATIBLE_READ_ONLY`):
 *   - `ENTER`: destino Compatíveis — a coluna nasce só do match, nunca de arrasto (DX-5.5);
 *   - `INVITE_BY_SEND`: origem Compatíveis e destino Invitados — virar convidado é ter
 *     sido mensageado (`messaged_at`, D432); arrasto não envia nada (DX-5.6).
 */
export type CompatibleRefusal = 'ENTER' | 'INVITE_BY_SEND';

/**
 * DX-5.5/5.6/5.17: entrar em Compatíveis nunca; sair para Invitados só pelo envio
 * (messaged_at) — venha de onde vier. Achado 🟡-1 do gate parcial 1: a versão anterior só
 * olhava `from.stage === 'INVITED'` (via `deriveKanbanColumn`), então um card que já tinha
 * saído de Compatíveis para Rejeitados/Confirmados/etc. — sem NUNCA ter sido mensageado
 * (`source === 'system'`, `messaged_at` nulo) — voltava para Invitados com 200 e reaparecia
 * em Compatíveis (reentrada indireta, o "200 que não muda o que diz" que a DX-5.6 quis
 * fechar). A recusa agora olha só `source`/`messagedAt` da origem, qualquer que seja a
 * etapa atual: `toStage === 'INVITED' && from.source === 'system' && from.messagedAt ==
 * null` (G5, achado 🟡 novo 3 do gate fecho: `== null` cobre `null` E `undefined`, igual a
 * `isMatchedNotInvited` em `kanbanColumn.ts` — a comparação estrita deixava passar
 * `messagedAt: undefined` e a recusa não disparava). Origem `null` (candidatura nova)
 * continua `null` — nunca é candidato do match.
 * `from.source !== 'system'` ou `messagedAt` presente → `null` (Invitado de verdade). As
 * demais saídas de Compatíveis seguem `requiredMoveReason` (Rejeitados com motivo de
 * rejeição; salto com motivo de salto). Roda ANTES de `requiredMoveReason`: para
 * Compatíveis → Invitados aquela devolve `null` (etapa igual, INVITED sobre INVITED), e o
 * upsert seria um 200 que não muda nada — o card voltaria a Compatíveis.
 */
export function compatibleMoveRefusal(from: MoveOrigin | null, toStage: string): CompatibleRefusal | null {
  if (toStage === COMPATIBLE_COLUMN) return 'ENTER';
  if (from !== null && toStage === 'INVITED' && from.source === 'system' && from.messagedAt == null) {
    return 'INVITE_BY_SEND';
  }
  return null;
}

/** 422 `COMPATIBLE_READ_ONLY` — o arrasto entra em Compatíveis ou tenta convidar sem envio. */
export class CompatibleReadOnlyError extends Error {
  constructor(readonly reason: CompatibleRefusal) {
    super(`compatible column is read-only: ${reason}`);
    this.name = 'CompatibleReadOnlyError';
  }
}

/**
 * Decide se o arrasto de `from` para `toStage` exige motivo, e de qual tipo.
 * Ordem (DX-4.6, `execucao/fase-4.md:426-427`):
 *   1. etapa igual (`from.stage === toStage`) → não há transição real, o gatilho da
 *      trilha nem grava linha (`169:45`) → `null`;
 *   2. origem `REJECTED` → `LEAVE_REJECTED`;
 *   3. destino `REJECTED` → `ENTER_REJECTED`;
 *   4. destino mais de uma posição À FRENTE de origem no quadro B
 *      (`kanbanColumn.ts:VACANCY_BOARD_COLUMNS`/`boardPosition`) → `JUMP`
 *      (recuo de qualquer tamanho não conta — só avanço);
 *   5. senão → `null`.
 * `from` nulo (candidatura nova) equivale a `{stage: null, source: null, messagedAt: null}` —
 * a MESMA posição de fallback que `deriveKanbanColumn` dá a um par stage/source
 * desconhecido: INVITED, posição 1 (Compatíveis é a 0, Fase 5). A origem Compatíveis
 * (INVITED/system sem `messaged_at`) fica na posição 0, e o deslocamento é uniforme: todo
 * par origem × destino da Fase 4 mantém o mesmo tipo. O destino é posicionado com
 * `source`/`messagedAt` nulos — nunca cai em Compatíveis (entrar lá é recusado antes, por
 * `compatibleMoveRefusal`).
 */
export function requiredMoveReason(from: MoveOrigin | null, toStage: string): MoveReasonKind | null {
  const origin: MoveOrigin = from ?? { stage: null, source: null, messagedAt: null };
  if (origin.stage === toStage) return null;
  if (origin.stage === 'REJECTED') return 'LEAVE_REJECTED';
  if (toStage === 'REJECTED') return 'ENTER_REJECTED';
  const jumped =
    boardPosition(toStage, null, null) - boardPosition(origin.stage, origin.source, origin.messagedAt) > 1;
  return jumped ? 'JUMP' : null;
}

/** A categoria enviada está na lista permitida para esse tipo de motivo? */
export function isAllowedMoveReason(kind: MoveReasonKind, category: unknown): boolean {
  return typeof category === 'string' && MOVE_REASONS_BY_KIND[kind].includes(category);
}

/** 422 `MOVE_REASON_REQUIRED` — o arrasto pede `reasonCategory` e o corpo não trouxe. */
export class MoveReasonRequiredError extends Error {
  constructor(readonly kind: MoveReasonKind) {
    super(`move reason required for kind: ${kind}`);
    this.name = 'MoveReasonRequiredError';
  }
}

/** 422 `MOVE_REASON_INVALID` — `reasonCategory` veio fora da lista permitida para `kind`. */
export class MoveReasonInvalidError extends Error {
  constructor(readonly kind: MoveReasonKind) {
    super(`move reason invalid for kind: ${kind}`);
    this.name = 'MoveReasonInvalidError';
  }
}
