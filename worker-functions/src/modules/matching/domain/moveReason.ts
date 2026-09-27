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

/** Etapa e fonte da candidatura ANTES do arrasto. `null` = nunca houve candidatura para essa vaga. */
export interface MoveOrigin {
  stage: string | null;
  source: string | null;
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
 * `from` nulo (candidatura nova) equivale a `{stage: null, source: null}` — a MESMA
 * posição de fallback que `deriveKanbanColumn` dá a um par stage/source desconhecido:
 * INVITED, posição 0.
 */
export function requiredMoveReason(from: MoveOrigin | null, toStage: string): MoveReasonKind | null {
  const origin = from ?? { stage: null, source: null };
  if (origin.stage === toStage) return null;
  if (origin.stage === 'REJECTED') return 'LEAVE_REJECTED';
  if (toStage === 'REJECTED') return 'ENTER_REJECTED';
  const jumped = boardPosition(toStage, null) - boardPosition(origin.stage, origin.source) > 1;
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
