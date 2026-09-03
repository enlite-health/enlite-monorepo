/**
 * AdmissionStatus — o funil de ADMISSÃO, separado do estado clínico (spec 012, US-B7).
 * `patients.admission_status` (migration 313), DERIVADO de `status` por trigger; o Kanban de
 * pacientes lê esta coluna: SOLICITANTE | ADMISSION | PENDING_ADMISSION | DONE ("Activo").
 * Rule: feedback_enum_values_english_uppercase.md
 */
export type AdmissionStatus = 'SOLICITANTE' | 'ADMISSION' | 'PENDING_ADMISSION' | 'DONE';

export const ADMISSION_STATUSES: readonly AdmissionStatus[] = [
  'SOLICITANTE',
  'ADMISSION',
  'PENDING_ADMISSION',
  'DONE',
] as const;

export function isAdmissionStatus(value: unknown): value is AdmissionStatus {
  return typeof value === 'string' && (ADMISSION_STATUSES as readonly string[]).includes(value);
}
