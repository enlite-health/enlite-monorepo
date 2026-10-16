import { isManualChangeSource, type ManualChangeSource, type PatientChangeSource } from './PatientChangeSource';

/**
 * Spec 051 (§4) — a troca clínica FORA do fluxo (liberada pela célula do destino) grava a origem
 * com a marca `*_override`, decidida pelo SERVIDOR. FONTE ÚNICA dos dois valores e do mapa
 * origem manual → override: o writer lê daqui, e o zod da rota continua aceitando SÓ
 * `MANUAL_CHANGE_SOURCES` (corpo com `*_override` → 400). Nenhum outro ponto concatena `_override`.
 */
export const OVERRIDE_CHANGE_SOURCE = {
  admin_panel: 'admin_panel_override',
  kanban: 'kanban_override',
} as const satisfies Record<ManualChangeSource, string>;
export type OverrideChangeSource = (typeof OVERRIDE_CHANGE_SOURCE)[ManualChangeSource];

/** O que vai para `patient_status_history.change_source`: a origem recebida ou a sua versão override. */
export type RecordedChangeSource = PatientChangeSource | OverrideChangeSource;

/**
 * Origem a gravar. `foraDoFluxo` só é verdadeiro para origem manual (a célula só vale para
 * `admin_panel`/`kanban`); qualquer outra origem passa intacta.
 */
export function recordedChangeSource(source: PatientChangeSource, foraDoFluxo: boolean): RecordedChangeSource {
  return foraDoFluxo && isManualChangeSource(source) ? OVERRIDE_CHANGE_SOURCE[source] : source;
}
