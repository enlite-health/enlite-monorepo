/**
 * workerDocumentFilters.ts
 *
 * Shared helper for the "all documents validated" filter used by both the
 * worker list endpoint and the export endpoint.
 *
 * Slug values here are the SQL/JSON keys stored in
 * worker_documents.document_validations — not the camelCase TS field names
 * from WorkerDocumentsRepository.
 *
 * Required slugs per profession are delegated to workerDocumentPolicy
 * (single source of truth). The constants below are re-exported for consumers
 * that need to reference them directly (e.g. E2E tests).
 *
 * Uses `jsonb_exists_all()` (the function form of `?&`) to avoid the `pg`
 * driver mis-interpreting `?` as a positional parameter placeholder.
 */

import { getRequiredSlugs } from './workerDocumentPolicy';

/** Required doc slugs for AT workers (re-exported for test convenience). */
export const REQUIRED_DOC_SLUGS_AT: readonly string[] = getRequiredSlugs('AT');

/** Required doc slugs for non-AT workers / profession=NULL (re-exported for test convenience). */
export const REQUIRED_DOC_SLUGS_BASE: readonly string[] = getRequiredSlugs(null);

/**
 * Internal: returns the bare CASE…END fragment (no outer parentheses, no IS NOT NULL guard).
 * Public functions wrap this with the IS NOT NULL check and optionally negate it.
 *
 * Branches:
 *   profession='AT'          → AT slugs  (identity_document, identity_document_back,
 *                                          criminal_record, resume_cv, at_certificate)
 *   profession IS NOT NULL    → base slugs (identity_document, identity_document_back,
 *                                          criminal_record)
 *   profession IS NULL        → base slugs (same as non-AT)
 */
function _allValidatedFragment(wdAlias: string): string {
  const atSlugs = REQUIRED_DOC_SLUGS_AT.map((s) => `'${s}'`).join(', ');
  const baseSlugs = REQUIRED_DOC_SLUGS_BASE.map((s) => `'${s}'`).join(', ');

  return (
    `CASE WHEN w.profession = 'AT'` +
    ` THEN jsonb_exists_all(${wdAlias}.document_validations, array[${atSlugs}])` +
    ` ELSE jsonb_exists_all(${wdAlias}.document_validations, array[${baseSlugs}])` +
    ` END`
  );
}

/**
 * Returns a SQL fragment that evaluates to true when the worker has ALL
 * required doc slugs present as keys in document_validations.
 *
 * Assumptions (matching the existing list/export queries):
 *   - The `workers` table is always aliased as `w`.
 *   - The `worker_documents` table alias is passed via `wdAlias` (typically 'wd').
 *
 * Usage in WHERE:
 *   `AND ${buildAllValidatedClause('wd')}`
 */
export function buildAllValidatedClause(wdAlias: string): string {
  return (
    `(${wdAlias}.document_validations IS NOT NULL` +
    ` AND (${_allValidatedFragment(wdAlias)}))`
  );
}

/**
 * Returns a SQL fragment that evaluates to true when the worker does NOT have
 * all required doc slugs validated. This is the semantic complement of
 * buildAllValidatedClause and includes:
 *   - workers with no worker_documents row (document_validations IS NULL via LEFT JOIN)
 *   - workers with an empty/partial JSONB object
 *   - workers with slugs missing for their profession
 *
 * Usage in WHERE:
 *   `AND ${buildPendingValidationClause('wd')}`
 */
export function buildPendingValidationClause(wdAlias: string): string {
  return (
    `NOT (${wdAlias}.document_validations IS NOT NULL` +
    ` AND (${_allValidatedFragment(wdAlias)}))`
  );
}
