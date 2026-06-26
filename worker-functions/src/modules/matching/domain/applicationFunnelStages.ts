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

// Migration 230 (2026-06-26): INITIATED → PRE_SCREENING
// PRE_SCREENING = quem entrou no formulário Talentum (antigo INITIATED)
export const POSTULATED_STAGES = ['PRE_SCREENING', 'IN_PROGRESS', 'COMPLETED'] as const;
export const PRE_SELECTED_STAGES = ['QUALIFIED', 'CONFIRMED', 'SELECTED'] as const;
export const REJECTION_STAGES = ['REJECTED'] as const;

/**
 * Stages que aparecem na coluna "Selecionados" do kanban (WJAFunnelController).
 * Usado pelo contador "Seleccionados" da listagem de vagas para que o número
 * bata exatamente com o que o operador vê ao abrir o kanban.
 * PLACED removido em F7.a (migration 194 — 0 linhas em prod, sync F6 morta).
 */
export const SELECTED_KANBAN_STAGES = ['SELECTED'] as const;

/**
 * Stages que aparecem na coluna "Confirmados" do kanban (WJAFunnelController).
 * Usado pelo contador "Confirmados" da listagem de vagas para que o número
 * bata exatamente com o que o operador vê ao abrir o kanban.
 */
export const CONFIRMED_KANBAN_STAGES = ['CONFIRMED'] as const;

export const POSTULATED_STAGES_SET: ReadonlySet<string> = new Set(POSTULATED_STAGES);
export const PRE_SELECTED_STAGES_SET: ReadonlySet<string> = new Set(PRE_SELECTED_STAGES);
export const REJECTION_STAGES_SET: ReadonlySet<string> = new Set(REJECTION_STAGES);

/** Renders a comma-separated list of single-quoted SQL literals. */
export function toSqlInList(stages: readonly string[]): string {
  return stages.map((s) => `'${s}'`).join(',');
}
