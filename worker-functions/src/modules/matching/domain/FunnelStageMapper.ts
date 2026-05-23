/**
 * FunnelStageMapper — interface para mapear estados de um provider externo
 * para o vocabulário canônico de ApplicationFunnelStage do funil interno Enlite.
 *
 * Cada provider de triagem implementa esta interface com sua própria lógica de
 * tradução. O vocabulário canônico coincide historicamente com os valores do
 * Talentum, mas é independente desse provider.
 *
 * Referência: docs/FOLLOWUPS.md TD-037
 */

export type FunnelStage =
  | 'INVITED'
  | 'INITIATED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'ANALYZED'
  | 'QUALIFIED'
  | 'NOT_QUALIFIED'
  | 'IN_DOUBT'
  | 'REPROGRAM'
  | 'CONFIRMED'
  | 'SELECTED'
  | 'PLACED'
  | 'REJECTED'
  | 'RECHAZADO';

export interface FunnelStageMapper<TProviderState> {
  /**
   * Traduz um estado do provider para o stage canônico Enlite.
   * Retorna null quando o estado não tem mapeamento conhecido
   * (o caller deve aplicar fallback conservador, ex: 'INITIATED').
   */
  mapToInternalStage(providerState: TProviderState): FunnelStage | null;
}
