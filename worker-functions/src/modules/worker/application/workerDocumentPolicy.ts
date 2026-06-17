/**
 * workerDocumentPolicy.ts
 *
 * Single source of truth for required-document rules per profession.
 *
 * Required fields by profession:
 *   AT      (profession = 'AT')           : DNI frente + DNI verso + Antecedentes + CV + Cert AT
 *   CUIDADOR (profession != 'AT', not null): DNI frente + DNI verso + Antecedentes
 *   UNKNOWN (profession = null or '')     : same as CUIDADOR (base set)
 *
 * NOT required for anyone: liability_insurance, professional_registration, monotributo_certificate.
 *
 * Three parallel representations are exported for each consumer:
 *   - SQL column names  → WorkerDocumentsRepository / recalculateStatus
 *   - JSONB slugs       → workerDocumentFilters / document_validations keys
 *   - camelCase fields  → TS DTOs / computeStatus
 */

export type ProfessionClass = 'AT' | 'CUIDADOR' | 'UNKNOWN';

/**
 * Classify a raw profession string into a canonical class.
 *
 * 'AT'                                     → AT
 * 'CAREGIVER' | 'NURSE' | 'KINESIOLOGIST'
 *   | 'PSYCHOLOGIST' (any non-empty, non-null, non-AT string) → CUIDADOR
 * null / ''                                → UNKNOWN
 */
export function classifyProfession(profession: string | null): ProfessionClass {
  if (profession === 'AT') return 'AT';
  if (profession !== null && profession !== '') return 'CUIDADOR';
  return 'UNKNOWN';
}

/** SQL column names shared by all professions. */
const BASE_COLUMNS: readonly string[] = [
  'identity_document_url',
  'identity_document_back_url',
  'criminal_record_url',
] as const;

/** SQL column names required only for AT (appended to BASE_COLUMNS). */
const AT_EXTRA_COLUMNS: readonly string[] = [
  'resume_cv_url',
  'at_certificate_url',
] as const;

/** JSONB slug names shared by all professions. */
const BASE_SLUGS: readonly string[] = [
  'identity_document',
  'identity_document_back',
  'criminal_record',
] as const;

/** JSONB slug names required only for AT (appended to BASE_SLUGS). */
const AT_EXTRA_SLUGS: readonly string[] = [
  'resume_cv',
  'at_certificate',
] as const;

/** camelCase field names shared by all professions. */
const BASE_CAMEL: readonly string[] = [
  'identityDocumentUrl',
  'identityDocumentBackUrl',
  'criminalRecordUrl',
] as const;

/** camelCase field names required only for AT (appended to BASE_CAMEL). */
const AT_EXTRA_CAMEL: readonly string[] = [
  'resumeCvUrl',
  'atCertificateUrl',
] as const;

/**
 * Returns the list of required SQL column names for the given profession.
 * Used by WorkerDocumentsRepository.computeStatus and recalculateStatus.
 */
export function getRequiredColumns(profession: string | null): string[] {
  const cls = classifyProfession(profession);
  if (cls === 'AT') return [...BASE_COLUMNS, ...AT_EXTRA_COLUMNS];
  return [...BASE_COLUMNS];
}

/**
 * Returns the list of required JSONB slug names for the given profession.
 * Used by workerDocumentFilters and document_validations queries.
 */
export function getRequiredSlugs(profession: string | null): string[] {
  const cls = classifyProfession(profession);
  if (cls === 'AT') return [...BASE_SLUGS, ...AT_EXTRA_SLUGS];
  return [...BASE_SLUGS];
}

/**
 * Returns the list of required camelCase field names for the given profession.
 * Used by WorkerDocumentsRepository.computeStatus.
 */
export function getRequiredCamelFields(profession: string | null): string[] {
  const cls = classifyProfession(profession);
  if (cls === 'AT') return [...BASE_CAMEL, ...AT_EXTRA_CAMEL];
  return [...BASE_CAMEL];
}
