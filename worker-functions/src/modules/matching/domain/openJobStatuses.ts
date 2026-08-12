/**
 * Single source of truth for "vaga viva" — a job posting actively looking for a
 * provider (job_postings.status, migration 166).
 *
 * Lived duplicated in three places (GetManagementDashboardUseCase's
 * vacantesAbiertas, GetZoneAnalyticsUseCase's demand filter, and every ad-hoc
 * dashboard query). Duplicated business rules are exactly what made the
 * management dashboard drift from the Kanban — keep this list in ONE place.
 *
 * Note this is only the STATUS half of "vaga viva". A live vacancy must also be
 * `deleted_at IS NULL AND is_draft = false` — see LIVE_JOB_POSTING_SQL.
 */
export const OPEN_JOB_STATUSES = [
  'SEARCHING',
  'SEARCHING_REPLACEMENT',
  'RAPID_RESPONSE',
  'PENDING_ACTIVATION',
] as const;

export const OPEN_JOB_STATUSES_SET: ReadonlySet<string> = new Set(OPEN_JOB_STATUSES);

/**
 * SQL predicate for a live vacancy, assuming the job_postings table is aliased `jp`.
 * Inlined (not parameterised) because the values are a compile-time constant list —
 * never user input.
 */
export const LIVE_JOB_POSTING_SQL = `jp.deleted_at IS NULL
    AND jp.is_draft = false
    AND jp.status IN (${OPEN_JOB_STATUSES.map((s) => `'${s}'`).join(',')})`;
