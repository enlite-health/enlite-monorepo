import { logger } from '@shared/logging';
import { BlockedApplicationRepository } from '../infrastructure/BlockedApplicationRepository';
import type { WorkerEligibilityReason } from '../domain/WorkerApplicationEligibility';

export interface RecordBlockedAttemptParams {
  workerId: string;
  jobPostingId: string;
  reason: WorkerEligibilityReason;
  acquisitionChannel: string | null;
}

/**
 * RecordBlockedAttemptUseCase
 *
 * Registra uma tentativa de postulação bloqueada em worker_blocked_applications.
 *
 * FIRE-AND-FORGET: nunca propaga exceção. Falhas são logadas como warn.
 * O 403 já foi emitido pelo controller antes de chamar este use case.
 *
 * Retorna os missingFields EXPANDIDOS (doc_* tokens) para inclusão no 403.
 * Em caso de falha, retorna [] em vez de propagar.
 *
 * Migration 209.
 */
export class RecordBlockedAttemptUseCase {
  private readonly repo: BlockedApplicationRepository;

  constructor() {
    this.repo = new BlockedApplicationRepository();
  }

  async execute(params: RecordBlockedAttemptParams): Promise<string[]> {
    try {
      return await this.repo.upsert({
        workerId: params.workerId,
        jobPostingId: params.jobPostingId,
        reason: params.reason,
        acquisitionChannel: params.acquisitionChannel,
      });
    } catch (err) {
      logger.warn({
        msg: 'RecordBlockedAttemptUseCase.execute: failed to record blocked attempt (non-fatal)',
        workerId: params.workerId,
        jobPostingId: params.jobPostingId,
        reason: params.reason,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }
}
