/**
 * Fase 4 — o motivo obrigatório no arrasto do quadro B (salto, entrar e sair de Rejeitados).
 * A regra de QUANDO pedir motivo mora só na API (`WF/domain/moveReason.ts`, DX-4.6) — este
 * arquivo é catálogo de RÓTULO das opções, não regra (DX-4.11). O front nunca decide "o que é
 * salto"; só reage ao 422 `MOVE_REASON_REQUIRED` (DX-4.10).
 */

/** Espelho do `MoveReasonKind` do backend (`WF/domain/moveReason.ts`, DX-4.6). */
export type MoveReasonKind = 'JUMP' | 'ENTER_REJECTED' | 'LEAVE_REJECTED';

/** Código do erro 422 que o `AdminApiService`/`ApiError` devolvem quando falta o motivo (DX-4.6). */
export const MOVE_REASON_REQUIRED = 'MOVE_REASON_REQUIRED';

/**
 * Categorias de rejeição (9 valores) — saiu de `RejectionReasonSelect.tsx` (era `REJECTION_OPTIONS`
 * local); é a mesma lista que a API valida como `ENTER_REJECTED` (DX-4.4, espelho de `Encuadre.ts`
 * no backend, sem cópia de nome de tipo).
 */
export const REJECTION_REASON_OPTIONS = [
  'DISTANCE',
  'SCHEDULE_INCOMPATIBLE',
  'INSUFFICIENT_EXPERIENCE',
  'SALARY_EXPECTATION',
  'WORKER_DECLINED',
  'OVERQUALIFIED',
  'DEPENDENCY_MISMATCH',
  'TALENTUM_NOT_QUALIFIED',
  'OTHER',
] as const;

/** As três listas de motivo (DX-4.4), pelo `MoveReasonKind` que o 422 devolve em `reason`. */
export const MOVE_REASON_OPTIONS: Record<MoveReasonKind, readonly string[]> = {
  JUMP: ['ENCUADRE_ANTECIPADO', 'REAPROVEITADO_DE_OUTRA_VAGA', 'INDICACAO_DA_EQUIPE', 'OTHER'],
  ENTER_REJECTED: REJECTION_REASON_OPTIONS,
  LEAVE_REJECTED: ['REAVALIACAO', 'REJEITADO_POR_ENGANO', 'OTHER'],
};

const MOVE_REASON_KINDS: readonly MoveReasonKind[] = ['JUMP', 'ENTER_REJECTED', 'LEAVE_REJECTED'];

export function isMoveReasonKind(value: unknown): value is MoveReasonKind {
  return typeof value === 'string' && (MOVE_REASON_KINDS as readonly string[]).includes(value);
}
