/**
 * PatientLanguage — idiomas em que o PACIENTE se comunica (spec 018, PR-3, Emenda 13/09).
 *
 * Lista fechada ISO, a MESMA de `workers.languages` (`WORKER_LANGUAGES`,
 * `enlite-frontend/src/domain/entities/Worker.ts:130`) — cresce só por migration + parecer do
 * `lex` (um idioma originário pode revelar origem étnica, Ley 25.326 art. 2). Stored in
 * `patients.languages_encrypted` (TEXT, JSON array cifrado como um ciphertext — migration 425,
 * mesmo molde de `workers.languages_encrypted`).
 */
export type PatientLanguage = 'pt' | 'es' | 'en';

export const PATIENT_LANGUAGES: readonly PatientLanguage[] = ['pt', 'es', 'en'] as const;

export function isPatientLanguage(value: unknown): value is PatientLanguage {
  return typeof value === 'string' && (PATIENT_LANGUAGES as readonly string[]).includes(value);
}
