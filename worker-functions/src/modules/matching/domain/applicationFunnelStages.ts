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
// Fase 4 (D430): QUICK_RESPONSE_TEAM entra em PRE_SELECTED — sem isso, classifyBucket
// (GetFunnelTableUseCase.ts) jogaria a linha no balde INVITED (fallback) e sair de
// Seleccionados baixaria a aba "Pre-seleccionados" (DX-4.9).
export const PRE_SELECTED_STAGES = ['QUALIFIED', 'CONFIRMED', 'SELECTED', 'QUICK_RESPONSE_TEAM'] as const;
export const REJECTION_STAGES = ['REJECTED'] as const;

/**
 * Stages que aparecem na coluna "Selecionados" do kanban (WJAFunnelController).
 * Usado pelo contador "Seleccionados" da listagem de vagas para que o número
 * bata exatamente com o que o operador vê ao abrir o kanban.
 * PLACED removido em F7.a (migration 194 — 0 linhas em prod, sync F6 morta).
 */
export const SELECTED_KANBAN_STAGES = ['SELECTED'] as const;

/**
 * Quem ocupa a posição da vaga — base de `faltantes` (vacancyListHelpers.ts). Critério 11
 * da Fase 4: `SELECTED → QUICK_RESPONSE_TEAM` não pode mudar `faltantes`
 * (`providers_needed − FILLED_POSITION_STAGES`), então as duas etapas contam aqui. O
 * contador "Seleccionados" (`SELECTED_KANBAN_STAGES`, acima) continua só `SELECTED` — ele
 * espelha a coluna "Seleccionados" do Kanban, não a posição da vaga.
 */
export const FILLED_POSITION_STAGES = ['SELECTED', 'QUICK_RESPONSE_TEAM'] as const;

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
