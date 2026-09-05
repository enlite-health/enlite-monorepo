/**
 * PatientCompleteness — espelha `worker-functions/src/modules/case/domain/PatientCompleteness.ts`
 * (spec 014 US-D1, lex D1.1/D1.2). Códigos administrativos, sem item clínico — a MESMA lista que
 * o backend usa tanto no checklist (`GET /:id`) quanto no gate de `POST /activate`.
 */

export const PATIENT_COMPLETENESS_CODES = [
  'ADDRESS',
  'RESPONSIBLE',
  'COVERAGE',
  'CONTRACTED_SERVICE',
  'CONSENT',
] as const;

export type PatientCompletenessCode = (typeof PATIENT_COMPLETENESS_CODES)[number];

/**
 * D255 (decisão 03/09) — espelha `ACTIVATION_BLOCKING_CODES` do backend
 * (`worker-functions/src/modules/case/domain/PatientCompleteness.ts`). SÓ ADDRESS bloqueia o
 * `POST /activate`; os demais 4 códigos são checklist informativo, não bloqueio.
 */
export const ACTIVATION_BLOCKING_CODES = ['ADDRESS'] as const;

/**
 * Status em que o checklist/botão "Activar paciente" fazem sentido — espelha
 * `ACTIVATABLE_STATUSES` do backend. Fonte ÚNICA no front: `ActivatePatientButton` e
 * `PatientDetailPage` leem esta constante em vez de manter cada um seu próprio `Set`.
 */
export const ACTIVATABLE_STATUSES = ['ADMISSION', 'PENDING_ADMISSION'] as const;

export interface PatientCompleteness {
  missing: PatientCompletenessCode[];
  /** missing ∩ ACTIVATION_BLOCKING_CODES (D255) — os códigos que REALMENTE bloqueiam o activate. */
  blocking: PatientCompletenessCode[];
  ready: boolean;
  /** blocking.length === 0. */
  canActivate: boolean;
}
