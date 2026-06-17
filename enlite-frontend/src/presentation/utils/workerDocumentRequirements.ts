/**
 * workerDocumentRequirements.ts
 *
 * Fonte única (SSOT) das regras de documentos obrigatórios por profissão —
 * espelho frontend da policy do backend em
 * worker-functions/src/modules/worker/application/workerDocumentPolicy.ts.
 *
 * Regra canônica:
 *   AT       (profession === 'AT')     : resumeCvUrl, identityDocumentUrl,
 *                                        identityDocumentBackUrl, criminalRecordUrl,
 *                                        atCertificateUrl
 *   Cuidador (qualquer outro valor,    : identityDocumentUrl, identityDocumentBackUrl,
 *             incluindo null/undefined): criminalRecordUrl
 *
 * NÃO obrigatórios para ninguém:
 *   professionalRegistrationUrl, liabilityInsuranceUrl, monotributoCertificateUrl.
 */

import type { WorkerDocumentsResponse } from '@infrastructure/http/DocumentApiService';

// ── Tipos ─────────────────────────────────────────────────────────────────────

export type ProfessionClass = 'AT' | 'CUIDADOR';

// ── Listas estáticas ──────────────────────────────────────────────────────────

/** Campos camelCase obrigatórios para AT */
const REQUIRED_FIELDS_AT: ReadonlyArray<keyof WorkerDocumentsResponse> = [
  'resumeCvUrl',
  'identityDocumentUrl',
  'identityDocumentBackUrl',
  'criminalRecordUrl',
  'atCertificateUrl',
] as const;

/** Slugs i18n (documentTypes.<slug>) obrigatórios para AT */
const REQUIRED_SLUGS_AT: ReadonlyArray<string> = [
  'resume_cv',
  'identity_document',
  'identity_document_back',
  'criminal_record',
  'at_certificate',
] as const;

/** Campos camelCase obrigatórios para Cuidador / não-AT */
const REQUIRED_FIELDS_CUIDADOR: ReadonlyArray<keyof WorkerDocumentsResponse> = [
  'identityDocumentUrl',
  'identityDocumentBackUrl',
  'criminalRecordUrl',
] as const;

/** Slugs i18n (documentTypes.<slug>) obrigatórios para Cuidador / não-AT */
const REQUIRED_SLUGS_CUIDADOR: ReadonlyArray<string> = [
  'identity_document',
  'identity_document_back',
  'criminal_record',
] as const;

// ── Funções públicas ──────────────────────────────────────────────────────────

/**
 * Classifica a profissão do worker em AT ou CUIDADOR.
 * Null, undefined e string vazia são tratados como CUIDADOR.
 */
export function classifyProfession(profession?: string | null): ProfessionClass {
  return profession === 'AT' ? 'AT' : 'CUIDADOR';
}

/**
 * Retorna os campos camelCase (keyof WorkerDocumentsResponse) obrigatórios
 * com base na profissão.
 */
export function getRequiredDocFields(
  profession?: string | null,
): ReadonlyArray<keyof WorkerDocumentsResponse> {
  return classifyProfession(profession) === 'AT'
    ? REQUIRED_FIELDS_AT
    : REQUIRED_FIELDS_CUIDADOR;
}

/**
 * Retorna os slugs i18n (usados como documentTypes.<slug>) obrigatórios
 * com base na profissão.
 */
export function getRequiredDocSlugs(profession?: string | null): ReadonlyArray<string> {
  return classifyProfession(profession) === 'AT'
    ? REQUIRED_SLUGS_AT
    : REQUIRED_SLUGS_CUIDADOR;
}

/**
 * Verifica se todos os documentos obrigatórios para a profissão estão presentes.
 * Retorna false se `documents` for null/undefined.
 */
export function areAllRequiredDocsComplete(
  documents: WorkerDocumentsResponse | null | undefined,
  profession?: string | null,
): boolean {
  if (!documents) return false;
  const fields = getRequiredDocFields(profession);
  return fields.every((field) => !!documents[field]);
}
