import { Request, Response } from 'express';
import { z } from 'zod';
import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { logger } from '@shared/logging';
import { GetWorkerProgressUseCase, WorkerRepository } from '@modules/worker';
import {
  assertWorkerCanApply,
  WorkerNotEligibleError,
} from '../../domain/WorkerApplicationEligibility';
import { RecordBlockedAttemptUseCase } from '../../application/RecordBlockedAttemptUseCase';
import { CreateManualWjaWithEncuadreUseCase } from '../../application/CreateManualWjaWithEncuadreUseCase';

const VALID_CHANNELS = ['facebook', 'instagram', 'whatsapp', 'linkedin', 'site'] as const;

const TrackChannelSchema = z.object({
  jobPostingId: z.string().min(1, 'jobPostingId is required'),
  // channel é opcional/nullable: a postulação é registrada em TODO clique (mesmo sem
  // UTM). Quando presente, deve ser um canal válido; ausente/null → acquisition_channel
  // fica NULL. Um valor de canal inválido continua sendo rejeitado (400).
  channel: z
    .enum(VALID_CHANNELS, {
      errorMap: () => ({
        message: `channel must be one of: ${VALID_CHANNELS.join(', ')}`,
      }),
    })
    .nullable()
    .default(null),
});

/**
 * WorkerApplicationsController
 *
 * Endpoints for worker-facing job application actions.
 *
 * - POST /api/worker-applications/track-channel
 *     Records the social acquisition channel for a WJA (first-touch wins).
 *     Auth: requireAuth (worker token)
 */
export class WorkerApplicationsController {
  private readonly db: Pool;
  private readonly getProgressUseCase: GetWorkerProgressUseCase;
  private readonly recordBlockedAttemptUseCase: RecordBlockedAttemptUseCase;
  private readonly createManualWjaWithEncuadreUseCase: CreateManualWjaWithEncuadreUseCase;

  constructor() {
    this.db = DatabaseConnection.getInstance().getPool();
    this.getProgressUseCase = new GetWorkerProgressUseCase(new WorkerRepository());
    this.recordBlockedAttemptUseCase = new RecordBlockedAttemptUseCase();
    this.createManualWjaWithEncuadreUseCase = new CreateManualWjaWithEncuadreUseCase();
  }

  private getAuthUid(req: Request): string | null {
    return (req as Request & { user?: { uid: string } }).user?.uid
      ?? (req.headers['x-auth-uid'] as string | undefined)
      ?? null;
  }

  private async resolveWorker(authUid: string): Promise<{
    id: string; name: string; phone: string;
  } | null> {
    const result = await this.getProgressUseCase.execute(authUid);
    if (result.isFailure) return null;
    const w = result.getValue() as {
      id: string; firstName?: string; lastName?: string; phone?: string;
    };
    const name = [w.firstName, w.lastName].filter(Boolean).join(' ');
    return { id: w.id, name: name || '', phone: w.phone || '' };
  }

  /**
   * POST /api/worker-applications/track-channel
   *
   * Body: { jobPostingId: string, channel: 'facebook' | 'instagram' | 'whatsapp' | 'linkedin' | 'site' }
   *
   * First-touch wins: if acquisition_channel already has a value, does NOT overwrite.
   * If no WJA exists, creates one with source='manual' and the given channel.
   */
  async trackChannel(req: Request, res: Response): Promise<void> {
    try {
      const authUid = this.getAuthUid(req);
      if (!authUid) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      const parsed = TrackChannelSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: parsed.error.errors.map(e => e.message).join('; '),
        });
        return;
      }

      const { jobPostingId, channel } = parsed.data;

      const worker = await this.resolveWorker(authUid);
      if (!worker) {
        res.status(404).json({ success: false, error: 'Worker not found' });
        return;
      }

      try {
        await assertWorkerCanApply(this.db, worker.id);
      } catch (err) {
        if (err instanceof WorkerNotEligibleError) {
          // Instrumenta a tentativa bloqueada. Awaited de propósito: em Cloud Run,
          // trabalho em background após o response é estrangulado/descartado, o que
          // perderia a gravação. A conexão já está quente (assertWorkerCanApply acima)
          // e o upsert é single-row indexado (latência sub-ms). O use case é à prova de
          // falha (try/catch interno, nunca lança), então o 403 nunca é bloqueado por erro.
          const missingFields = await this.recordBlockedAttemptUseCase.execute({
            workerId: worker.id,
            jobPostingId,
            reason: err.reason,
            acquisitionChannel: channel,
          });
          res.status(err.status).json({
            success: false,
            error: 'registration_incomplete',
            code: err.code,
            reason: err.reason,
            workerStatus: err.workerStatus,
            missingFields,
          });
          return;
        }
        throw err;
      }

      // Worker self-applied via public link, lands in INVITED column.
      // (Clicou no link, ainda não entrou no WhatsApp Talentum — INITIATED só via webhook.)
      // Extraído para CreateManualWjaWithEncuadreUseCase (reusado por PromoteBlockedApplicationsUseCase).
      await this.createManualWjaWithEncuadreUseCase.execute(this.db, {
        workerId: worker.id,
        jobPostingId,
        acquisitionChannel: channel,
        workerName: worker.name,
        workerPhone: worker.phone,
      });

      res.status(200).json({ success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ msg: '[WorkerApplicationsController] trackChannel error', error: message });
      res.status(500).json({ success: false, error: message });
    }
  }
}
