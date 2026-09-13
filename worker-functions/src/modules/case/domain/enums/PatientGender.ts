/**
 * PatientGender — gênero declarado do PACIENTE (spec 018, PR-3, Emenda 13/09 do registro de
 * operações; `lex` CONDICIONADO #2a/#2b).
 *
 * Distinto de `Sex.ts` (sexo atribuído ao nascer, uso clínico) e do `Gender.ts` do módulo worker
 * (vocabulário próprio de prestador, com TRANS/UNDISCLOSED). Stored in
 * `patients.gender_encrypted` (TEXT, KMS encrypted — migration 425). Sem CHECK no banco: a
 * coluna é cifrada, então nenhuma constraint SQL a alcança; o fechamento é só aqui (Zod).
 *
 * `PREFER_NOT_TO_SAY` é resposta EXPLÍCITA de não informar — distinta de `null` (não perguntado).
 */
export type PatientGender = 'FEMALE' | 'MALE' | 'NON_BINARY' | 'OTHER' | 'PREFER_NOT_TO_SAY';

export const PATIENT_GENDERS: readonly PatientGender[] = [
  'FEMALE',
  'MALE',
  'NON_BINARY',
  'OTHER',
  'PREFER_NOT_TO_SAY',
] as const;

export function isPatientGender(value: unknown): value is PatientGender {
  return typeof value === 'string' && (PATIENT_GENDERS as readonly string[]).includes(value);
}
