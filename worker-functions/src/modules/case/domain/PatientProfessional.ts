/**
 * Equipe tratante do paciente — `patient_professionals` (038/068/071/420/427; spec 018 PR-5,
 * US-11; `lex` 12/09 CONDICIONADO). Terceiros (profissionais de saúde) que atendem o paciente:
 * o vínculo "profissional X de especialidade Y atende o paciente Z" é dado de SAÚDE do paciente
 * (regime clínico completo, incluindo `specialty`) — mesma régua de `PatientCoverageEmergencyContact`
 * para o `DIRECT_PROFESSIONAL` (lex C3: é o MESMO dado, só sai com `patient_care_team:read`).
 *
 * Escrita por linha (spec 018, PR-1, ADR-1): `insertOne`/`updateOne`/`deactivate`, nunca
 * `replaceAll` para a linha do PAINEL — o `replacePatientProfessionals` (sync do ClickUp) continua
 * existindo, mas só toca `source='clickup'` (achado do gate revisao-pr, já corrigido no PR-1).
 */
export const PATIENT_PROFESSIONAL_SPECIALTIES = [
  'PHYSICIAN',
  'PSYCHIATRIST',
  'NEUROLOGIST',
  'PEDIATRICIAN',
  'PSYCHOLOGIST',
  'PHYSIOTHERAPIST',
  'OCCUPATIONAL_THERAPIST',
  'SPEECH_THERAPIST',
  'NUTRITIONIST',
  'NURSE',
  'SOCIAL_WORKER',
  'OTHER',
] as const;
export type PatientProfessionalSpecialty = (typeof PATIENT_PROFESSIONAL_SPECIALTIES)[number];

export const PATIENT_PROFESSIONAL_NAME_MAX = 200;
export const PATIENT_PROFESSIONAL_PHONE_MAX = 40;

/** `POST /patients/:id/professionals` — corpo completo. `isTeam` nasce sempre `false` pelo painel:
 * a entrada especial "equipe multidisciplinar" só existe hoje vinda do ClickUp (038). */
export interface PatientProfessionalInput {
  name: string;
  phone: string | null;
  email: string | null;
  specialty: PatientProfessionalSpecialty | null;
}

/** O que a ficha lê (telefone/e-mail já decifrados — só quando o ator tem `patient_care_team:read`). */
export interface PatientProfessionalDetail {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  specialty: PatientProfessionalSpecialty | null;
  displayOrder: number;
  isTeam: boolean;
}

/** PATCH parcial de uma linha (RFC 7396). `name` não aceita `null` (coluna NOT NULL). */
export interface PatientProfessionalPatch {
  name?: string;
  phone?: string | null;
  email?: string | null;
  specialty?: PatientProfessionalSpecialty | null;
}
