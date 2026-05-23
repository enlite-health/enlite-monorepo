/**
 * TalentumFunnelStageMapper
 *
 * Implementação de FunnelStageMapper para o provider Talentum.
 * Traduz profile.status do dashboard Talentum (e subtype do webhook) para o
 * stage canônico Enlite.
 *
 * Hoje é quase identity: os valores do Talentum são o vocabulário canônico.
 * Existe para desacoplar o domínio do provider e preparar para TD-037.
 *
 * Valores de entrada conhecidos (fonte: TalentumPrescreeningSchema + dashboard API):
 *   - INITIATED, IN_PROGRESS, COMPLETED, ANALYZED (webhook subtype)
 *   - QUALIFIED, NOT_QUALIFIED, IN_DOUBT (statusLabel em ANALYZED)
 *   - PENDING (statusLabel em ANALYZED — mapeia para ANALYZED, sem status label final)
 *   - INVITED (dashboard only)
 *
 * Referência: docs/FOLLOWUPS.md TD-035 + TD-037
 */

import type { FunnelStage, FunnelStageMapper } from '@modules/matching/domain/FunnelStageMapper';

/** Status recebidos do dashboard Talentum (profile.status) ou do webhook (subtype) */
export type TalentumProviderStatus = string;

export class TalentumFunnelStageMapper implements FunnelStageMapper<TalentumProviderStatus> {
  private static readonly KNOWN_STAGES = new Map<string, FunnelStage>([
    ['INVITED',       'INVITED'],
    ['INITIATED',     'INITIATED'],
    ['IN_PROGRESS',   'IN_PROGRESS'],
    ['COMPLETED',     'COMPLETED'],
    ['ANALYZED',      'ANALYZED'],
    ['IN_DOUBT',      'IN_DOUBT'],
    ['QUALIFIED',     'QUALIFIED'],
    ['NOT_QUALIFIED', 'NOT_QUALIFIED'],
    ['REPROGRAM',     'REPROGRAM'],
    ['CONFIRMED',     'CONFIRMED'],
    ['SELECTED',      'SELECTED'],
    ['PLACED',        'PLACED'],
    ['REJECTED',      'REJECTED'],
    ['RECHAZADO',     'RECHAZADO'],
    // PENDING vem como statusLabel em ANALYZED — representa análise em andamento
    // sem conclusão → mapeia para ANALYZED (estado de análise sem resultado final)
    ['PENDING',       'ANALYZED'],
  ]);

  mapToInternalStage(providerState: TalentumProviderStatus): FunnelStage | null {
    if (!providerState) return null;
    return TalentumFunnelStageMapper.KNOWN_STAGES.get(providerState.trim().toUpperCase()) ?? null;
  }
}
