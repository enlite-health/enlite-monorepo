/**
 * SuspensionExitReason — por que o paciente SAI de SUSPENDED (decisão do Gabriel 29/09/2026).
 * Rótulo fechado (catálogo), SEM texto livre — texto livre viraria anotação clínica, e a trilha
 * (`patient_status_history`) é append-only e nunca guarda texto clínico (mesmo espírito de
 * `on_hold_note`, C7.3, mas aqui a saída deliberada é NÃO ter campo livre nenhum).
 * CHECK em `patient_status_history.reason` (migration 486).
 * Rule: feedback_enum_values_english_uppercase.md
 */
export type SuspensionExitReason =
  | 'RESUMED_SERVICE'   // retoma do serviço: fim de férias/internação
  | 'FAMILY_REQUESTED'  // família pediu retomar
  | 'NEEDS_NEW_WORKER'  // precisa de novo prestador
  | 'WRONG_STATUS'      // estado carregado errado
  | 'OTHER';

export const SUSPENSION_EXIT_REASONS: readonly SuspensionExitReason[] = [
  'RESUMED_SERVICE',
  'FAMILY_REQUESTED',
  'NEEDS_NEW_WORKER',
  'WRONG_STATUS',
  'OTHER',
] as const;

export function isSuspensionExitReason(value: unknown): value is SuspensionExitReason {
  return typeof value === 'string' && (SUSPENSION_EXIT_REASONS as readonly string[]).includes(value);
}
