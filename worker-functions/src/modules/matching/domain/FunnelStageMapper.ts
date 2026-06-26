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
  | 'INITIATED'       // Talentum webhook subtype — mapeado para PRE_SCREENING internamente (migration 230)
  | 'PRE_SCREENING'   // Canônico interno (antigo INITIATED — migration 230)
  | 'IN_PROGRESS'
  | 'COMPLETED'
  // 'ANALYZED' permanece em FunnelStage como vocabulário de protocolo Talentum,
  // mas NUNCA persiste em worker_job_applications.application_funnel_stage
  // (ApplicationFunnelStage em WorkerJobApplication.ts não o inclui).
  // Usado como sentinel em ProcessTalentumPrescreening.deriveFunnelStage()
  // para pular upsert em WJA quando statusLabel === 'PENDING'.
  | 'ANALYZED'
  | 'QUALIFIED'
  | 'NOT_QUALIFIED'
  | 'IN_DOUBT'
  // 'REPROGRAM' removido em F7.b (migration 195) — worker reschedule agora vive em
  // CONFIRMED + interview_response='awaiting_reschedule' (ADR-003).
  | 'CONFIRMED'
  | 'SELECTED'
  // 'PLACED' removido em F7.a (migration 194) — 0 writers ativos pós-F6,
  // 0 linhas em prod. ADR-002 + ADR-003. Não consta mais em ApplicationFunnelStage
  // nem é mapeado pelo TalentumFunnelStageMapper.
  | 'REJECTED';

export interface FunnelStageMapper<TProviderState> {
  /**
   * Traduz um estado do provider para o stage canônico Enlite.
   * Retorna null quando o estado não tem mapeamento conhecido
   * (o caller deve aplicar fallback conservador, ex: 'INITIATED').
   */
  mapToInternalStage(providerState: TProviderState): FunnelStage | null;
}
