import { Request, Response } from 'express';
import { z } from 'zod';
import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { logger } from '@shared/logging';
import { GetWorkerProgressUseCase, WorkerRepository } from '@modules/worker';
import { ApplyToVacancyUseCase } from '../../application/ApplyToVacancyUseCase';

// 'luz_whatsapp' = postulação registrada pela Luz na conversa (≠ 'whatsapp',
// que é clique humano em link de WhatsApp) — atribuição da conversão da IA.
const VALID_CHANNELS = ['facebook', 'instagram', 'whatsapp', 'linkedin', 'site', 'luz_whatsapp'] as const;

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
  private readonly applyToVacancyUseCase: ApplyToVacancyUseCase;

  constructor() {
    this.db = DatabaseConnection.getInstance().getPool();
    this.getProgressUseCase = new GetWorkerProgressUseCase(new WorkerRepository());
    this.applyToVacancyUseCase = new ApplyToVacancyUseCase();
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

      // Worker self-applied via public link, lands in INVITED column.
      // (Clicou no link, ainda não entrou no WhatsApp Talentum — INITIATED só via webhook.)
      // Elegibilidade + instrumentação de bloqueio + criação vivem no
      // ApplyToVacancyUseCase (fonte única — mesma composição da capability da Luz).
      const applyResult = await this.applyToVacancyUseCase.execute(this.db, {
        workerId: worker.id,
        jobPostingId,
        acquisitionChannel: channel,
        workerName: worker.name,
        workerPhone: worker.phone,
      });

      if (!applyResult.ok) {
        res.status(applyResult.httpStatus).json({
          success: false,
          error: 'registration_incomplete',
          code: applyResult.code,
          reason: applyResult.reason,
          workerStatus: applyResult.workerStatus,
          missingFields: applyResult.missingFields,
        });
        return;
      }

      res.status(200).json({ success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ msg: '[WorkerApplicationsController] trackChannel error', error: message });
      res.status(500).json({ success: false, error: message });
    }
  }
}
