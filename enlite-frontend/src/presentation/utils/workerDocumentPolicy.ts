/**
 * workerDocumentPolicy.ts (frontend SSOT)
 *
 * Mirrors the SQL gate that actually decides whether a worker can apply
 * (`fn_worker_missing_fields`, migration 212, and the identical `is_complete`
 * condition in `recalculateStatus`, which flips the worker to REGISTERED):
 *
 *   AND identity_document_url IS NOT NULL
 *   AND criminal_record_url   IS NOT NULL
 *   AND ( profession != 'AT' OR (resume_cv_url IS NOT NULL AND at_certificate_url IS NOT NULL) )
 *
 * SQL three-valued logic: when `profession IS NULL`, `profession != 'AT'` is
 * NULL (not TRUE), so the OR only passes when resume_cv AND at_certificate are
 * present — i.e. NULL/'' profession is treated as AT for documents. The same
 * parity is enforced by BlockedApplicationRepository.expandDocumentToken on the
 * backend (which feeds the blocking modal).
 *
 * NOTE: this intentionally DIVERGES from the backend's TS helper
 * worker-functions/.../workerDocumentPolicy.ts, which classifies NULL as
 * UNKNOWN→BASE. That helper does NOT gate postulación; the SQL gate above does.
 * Keep this file in parity with the SQL gate, not with that TS helper.
 */

import type { DocumentType } from '@infrastructure/http/DocumentApiService';

/** True when the profession requires AT documents per the SQL gate (NULL/'' = AT). */
export function isATProfession(profession: string | null | undefined): boolean {
  return profession === 'AT' || profession === null || profession === undefined || profession === '';
}

/** Documents shared by every profession (gate-required). */
const BASE_REQUIRED_DOCS: readonly DocumentType[] = ['identity_document', 'criminal_record'];

/** Extra documents required only for AT (gate-required). */
const AT_EXTRA_REQUIRED_DOCS: readonly DocumentType[] = ['resume_cv', 'at_certificate'];

/**
 * The documents that BLOCK postulación for the given profession.
 * Note: apto_psicofisico / analitico_universitario are AT-only UI slots but are
 * NOT gate-required, so they are intentionally excluded here (they stay optional).
 */
export function requiredDocTypesFor(profession: string | null | undefined): DocumentType[] {
  return isATProfession(profession)
    ? [...BASE_REQUIRED_DOCS, ...AT_EXTRA_REQUIRED_DOCS]
    : [...BASE_REQUIRED_DOCS];
}
