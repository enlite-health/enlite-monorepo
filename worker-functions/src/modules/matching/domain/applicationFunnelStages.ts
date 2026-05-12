/**
 * Canonical bucket → funnel_stage mapping for worker_job_applications.
 *
 * Used by:
 *  - GetFunnelTableUseCase (vacancy detail funnel tabs)
 *  - vacancyListHelpers     (admin vacancies listing counters)
 *
 * Keeping a single source of truth ensures the listing counters match the
 * counts shown when opening the vacancy detail.
 */

export const POSTULATED_STAGES = ['INITIATED', 'IN_PROGRESS', 'COMPLETED'] as const;
export const PRE_SELECTED_STAGES = ['QUALIFIED', 'CONFIRMED', 'SELECTED', 'PLACED'] as const;
export const REJECTION_STAGES = ['REJECTED', 'NOT_QUALIFIED', 'RECHAZADO'] as const;

export const POSTULATED_STAGES_SET: ReadonlySet<string> = new Set(POSTULATED_STAGES);
export const PRE_SELECTED_STAGES_SET: ReadonlySet<string> = new Set(PRE_SELECTED_STAGES);
export const REJECTION_STAGES_SET: ReadonlySet<string> = new Set(REJECTION_STAGES);

/** Renders a comma-separated list of single-quoted SQL literals. */
export function toSqlInList(stages: readonly string[]): string {
  return stages.map((s) => `'${s}'`).join(',');
}
