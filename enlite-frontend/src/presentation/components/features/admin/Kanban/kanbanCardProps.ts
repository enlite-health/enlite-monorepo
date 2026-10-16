import type { FunnelStages } from '@hooks/admin/useWJAFunnel';

/** Um card do funil (o mesmo shape em qualquer etapa). */
export type FunnelCard = FunnelStages[keyof FunnelStages][number];

/**
 * Props de exibição do card — as MESMAS na coluna e no overlay de arrasto.
 * Estavam escritas duas vezes; qualquer campo novo entrava só numa e o card
 * arrastado ficava diferente do card parado.
 */
export function cardProps(enc: FunnelCard, stage: string) {
  return {
    id: enc.id,
    workerId: enc.workerId,
    workerName: enc.workerName,
    workerPhone: enc.workerPhone,
    occupation: enc.occupation,
    workZone: enc.workZone,
    matchScore: enc.matchScore,
    talentumStatus: enc.talentumStatus,
    rejectionReasonCategory: enc.rejectionReasonCategory,
    interviewDate: enc.interviewDate,
    interviewTime: enc.interviewTime,
    stage,
    interviewResponse: enc.interviewResponse,
    meetLink: enc.meetLink,
    acquisitionChannel: enc.acquisitionChannel,
    internalStage: enc.internalStage ?? null,
    isBlocked: enc.isBlocked,
    blockedReason: enc.blockedReason,
    missingFields: enc.missingFields,
    attemptCount: enc.attemptCount,
    lastMessagedAt: enc.lastMessagedAt ?? null,
    lastStageMessage: enc.lastStageMessage ?? null,
    resendBlockedReason: enc.resendBlockedReason ?? null,
    convocation: enc.convocation ?? null,
    enquadreOrigin: enc.enquadreOrigin ?? null,
  };
}
