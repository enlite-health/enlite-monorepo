/**
 * Origem de uma mudança de status do paciente (`patient_status_history.change_source`, via
 * `app.change_source`). FONTE ÚNICA da união e da lista das origens MANUAIS — o writer, o zod da
 * rota e `decidirTrocaForaDoFluxo` leem daqui; nenhum deles repete o literal.
 */

/** Origens que são decisão de uma PESSOA no painel — as únicas que a rota HTTP aceita. */
export const MANUAL_CHANGE_SOURCES = ['admin_panel', 'kanban'] as const;
export type ManualChangeSource = (typeof MANUAL_CHANGE_SOURCES)[number];

/** Origens internas (use cases, hooks, derivação): o zod da rota HTTP NÃO as aceita. */
export const INTERNAL_CHANGE_SOURCES = ['activate', 'system', 'vacancy_launch', 'recruitment_activation'] as const;
export type InternalChangeSource = (typeof INTERNAL_CHANGE_SOURCES)[number];

export type PatientChangeSource = ManualChangeSource | InternalChangeSource;

export function isManualChangeSource(value: unknown): value is ManualChangeSource {
  return typeof value === 'string' && (MANUAL_CHANGE_SOURCES as readonly string[]).includes(value);
}
