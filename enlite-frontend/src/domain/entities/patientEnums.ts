/**
 * patientEnums — os vocabulários do paciente que a tela TRADUZ (spec 012, bloco B).
 *
 * Espelham os enums do backend (`worker-functions/src/modules/case/domain/enums`). Quem traduz é
 * o frontend (`admin.patients.*Options.<CODE>` em es/pt-BR); o teste
 * `enumTranslationCoverage.test.ts` falha se um código ficar sem rótulo.
 *
 * ⚠️ Cobertura e dispositivo são CATÁLOGOS do banco (editáveis sem deploy pelo endpoint admin).
 * As listas daqui são o SEED (33 do contrato 001 / 5 da migration 307): o select carrega o
 * catálogo vivo e cai no próprio código quando aparece um novo — `t(key, code)`.
 */

/** Funil de admissão em `patients.status` (legado até o backfill; o Kanban lê `admissionStatus`). */
export const ADMISSION_FUNNEL_STATUSES = ['SOLICITANTE', 'ADMISSION', 'PENDING_ADMISSION'] as const;
export type AdmissionFunnelStatus = (typeof ADMISSION_FUNNEL_STATUSES)[number];

/** Estado clínico v2 — decisão 2 do Gabriel (03/09/2026). */
export const CLINICAL_PATIENT_STATUSES = ['ACTIVE', 'ON_HOLD', 'SEARCHING', 'REPLACEMENT', 'SUSPENDED', 'DISCHARGED'] as const;
export type ClinicalPatientStatus = (typeof CLINICAL_PATIENT_STATUSES)[number];

export const PATIENT_STATUSES: readonly (AdmissionFunnelStatus | ClinicalPatientStatus)[] = [
  ...ADMISSION_FUNNEL_STATUSES,
  ...CLINICAL_PATIENT_STATUSES,
];
export type PatientStatus = (typeof PATIENT_STATUSES)[number];

/** Motivo da espera (ON_HOLD). O texto livre que o acompanha é clínico restrito (D211.2). */
export const ON_HOLD_REASONS = ['SCHOOL', 'INSURER', 'OTHER'] as const;
export type OnHoldReason = (typeof ON_HOLD_REASONS)[number];

/** `patients.admission_status` (migration 313) — a coluna do Kanban; DONE = "Activo". */
export const ADMISSION_STATUSES = ['SOLICITANTE', 'ADMISSION', 'PENDING_ADMISSION', 'DONE'] as const;
export type AdmissionStatus = (typeof ADMISSION_STATUSES)[number];

/** Seed de `device_types` (migration 307). */
export const DEVICE_TYPE_CODES = ['HOME', 'SCHOOL', 'INSTITUTIONAL', 'INPATIENT', 'TRANSPORT'] as const;
export type DeviceTypeCode = (typeof DEVICE_TYPE_CODES)[number];

/** `patient_responsibles.relationship` (CHECK da migration 139). */
export const RELATIONSHIP_CODES = ['CHILD', 'PARENT', 'SIBLING', 'NEPHEW', 'GRANDCHILD', 'GUARDIAN', 'FRIEND', 'PARTNER', 'OTHER'] as const;
export type RelationshipCode = (typeof RELATIONSHIP_CODES)[number];

/** `patient_professionals.specialty` (CHECK `pp_specialty_check`, migration 427; spec 018 PR-5, SUP-38). */
export const PATIENT_PROFESSIONAL_SPECIALTY_CODES = [
  'PHYSICIAN', 'PSYCHIATRIST', 'NEUROLOGIST', 'PEDIATRICIAN', 'PSYCHOLOGIST', 'PHYSIOTHERAPIST',
  'OCCUPATIONAL_THERAPIST', 'SPEECH_THERAPIST', 'NUTRITIONIST', 'NURSE', 'SOCIAL_WORKER', 'OTHER',
] as const;
export type PatientProfessionalSpecialtyCode = (typeof PATIENT_PROFESSIONAL_SPECIALTY_CODES)[number];

/** Seed de `insurance_providers` (migration 311) — os 33 do contrato 001 §Enums canônicos. */
export const INSURANCE_PROVIDER_CODES = [
  'API', 'ACCORD_SALUD', 'ASISOC', 'AVALIAN', 'BANCARIOS', 'CASA', 'DAS', 'GALENO', 'MHM', 'MEDICUS',
  'HTAL_BRITANICO', 'OSPJN', 'OSPECOM', 'OSMECON', 'OSDE', 'OMINT', 'OSPOCE', 'OGORMAN', 'OSPATCA', 'OBSBA',
  'OSPELSYM', 'OSTEE_LUZ_MEDICA', 'OSDEPYM', 'OTHER', 'PFA_SUPERINTENDENCIA', 'PRIVATE', 'SANIDAD',
  'SWISS_MEDICAL', 'UP', 'OSPICHA', 'USUOMRA', 'PREVENCION_SALUD', 'IOSCOR',
] as const;
export type InsuranceProviderCode = (typeof INSURANCE_PROVIDER_CODES)[number];
