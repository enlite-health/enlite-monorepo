/**
 * OnHoldReason — por que o cuidado está EN ESPERA (status ON_HOLD). Spec 012, US-B7.
 * Rótulo fechado (catálogo): SCHOOL (escola) | INSURER (obra social) | OTHER.
 * O texto livre que o acompanha (`on_hold_note`) é TEXTO CLÍNICO RESTRITO — pacote D211.2.
 * CHECK em `patients.on_hold_reason` (migration 314).
 * Rule: feedback_enum_values_english_uppercase.md
 */
export type OnHoldReason = 'SCHOOL' | 'INSURER' | 'OTHER';

export const ON_HOLD_REASONS: readonly OnHoldReason[] = ['SCHOOL', 'INSURER', 'OTHER'] as const;

export function isOnHoldReason(value: unknown): value is OnHoldReason {
  return typeof value === 'string' && (ON_HOLD_REASONS as readonly string[]).includes(value);
}
