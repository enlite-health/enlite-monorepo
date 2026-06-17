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
 * Migration 209.
 */
export class RecordBlockedAttemptUseCase {
  private readonly repo: BlockedApplicationRepository;

  constructor() {
    this.repo = new BlockedApplicationRepository();
  }

  async execute(params: RecordBlockedAttemptParams): Promise<void> {
    try {
      await this.repo.upsert({
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
    }
  }
}
