/**
 * PatientStatus — vocabulário canônico do ciclo de vida do paciente. **v2** (spec 012, US-B7).
 *
 * Duas famílias, de propósito separadas:
 *
 *   FUNIL DE ADMISSÃO — SOLICITANTE | ADMISSION | PENDING_ADMISSION
 *     Continuam aceitos em `patients.status` ("legados até o backfill") porque SLA, funil, stats
 *     e o botão Activar os leem. A coluna que o Kanban lê é `patients.admission_status`
 *     (migration 313), DERIVADA de `status` por trigger: enquanto o paciente está no funil,
 *     `admission_status = status`; assim que entra num estado clínico, `admission_status = 'DONE'`.
 *
 *   ESTADO CLÍNICO (decisão 2 do Gabriel, 03/09/2026 — `#DEC-06/07`, `#PEND-10`):
 *     ACTIVE · ON_HOLD (en espera — exige `on_hold_reason`) · SEARCHING (búsqueda) ·
 *     REPLACEMENT (reemplazo) · SUSPENDED · DISCHARGED (baja)
 *     As transições permitidas vivem em `patient_status_transitions` (migration 315) e são
 *     validadas em `PatientService.moveStatus`. ⚠️ SUP-B7: nenhuma derivação automática por horas.
 *
 * DISCONTINUED saiu do vocabulário: a migration 314 converteu as linhas em DISCHARGED e o CHECK
 * ainda o tolera só até o código antigo sumir do ar. `isPatientStatus('DISCONTINUED')` é false.
 *
 * Rule: feedback_enum_values_english_uppercase.md
 */

export type AdmissionFunnelStatus = 'SOLICITANTE' | 'ADMISSION' | 'PENDING_ADMISSION';

export type ClinicalPatientStatus =
  | 'ACTIVE'       // em atendimento
  | 'ON_HOLD'      // en espera — motivo obrigatório (SCHOOL | INSURER | OTHER)
  | 'SEARCHING'    // búsqueda de prestador
  | 'REPLACEMENT'  // reemplazo de prestador
  | 'SUSPENDED'    // suspensão (internação/viagem)
  | 'DISCHARGED';  // baja

export type PatientStatus = AdmissionFunnelStatus | ClinicalPatientStatus;

export const ADMISSION_FUNNEL_STATUSES: readonly AdmissionFunnelStatus[] = [
  'SOLICITANTE',
  'ADMISSION',
  'PENDING_ADMISSION',
] as const;

export const CLINICAL_PATIENT_STATUSES: readonly ClinicalPatientStatus[] = [
  'ACTIVE',
  'ON_HOLD',
  'SEARCHING',
  'REPLACEMENT',
  'SUSPENDED',
  'DISCHARGED',
] as const;

export const PATIENT_STATUSES: readonly PatientStatus[] = [
  ...ADMISSION_FUNNEL_STATUSES,
  ...CLINICAL_PATIENT_STATUSES,
] as const;

export function isPatientStatus(value: unknown): value is PatientStatus {
  return typeof value === 'string' && (PATIENT_STATUSES as readonly string[]).includes(value);
}

export function isClinicalPatientStatus(value: unknown): value is ClinicalPatientStatus {
  return typeof value === 'string' && (CLINICAL_PATIENT_STATUSES as readonly string[]).includes(value);
}

export function isAdmissionFunnelStatus(value: unknown): value is AdmissionFunnelStatus {
  return typeof value === 'string' && (ADMISSION_FUNNEL_STATUSES as readonly string[]).includes(value);
}
