import { Request, Response } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { GetWorkerProgressUseCase, WorkerRepository } from '@modules/worker';
import {
  assertWorkerCanApply,
  WorkerNotEligibleError,
} from '../../domain/WorkerApplicationEligibility';

const VALID_CHANNELS = ['facebook', 'instagram', 'whatsapp', 'linkedin', 'site'] as const;

const TrackChannelSchema = z.object({
  jobPostingId: z.string().min(1, 'jobPostingId is required'),
  channel: z.enum(VALID_CHANNELS, {
    errorMap: () => ({
      message: `channel must be one of: ${VALID_CHANNELS.join(', ')}`,
    }),
  }),
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

  constructor() {
    this.db = DatabaseConnection.getInstance().getPool();
    this.getProgressUseCase = new GetWorkerProgressUseCase(new WorkerRepository());
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
          res.status(err.status).json({
            success: false,
            error: 'registration_incomplete',
            code: err.code,
            reason: err.reason,
            workerStatus: err.workerStatus,
          });
          return;
        }
        throw err;
      }

      // Upsert WJA: worker self-applied via public link, lands in INVITED column.
      // (Clicou no link, ainda não entrou no WhatsApp Talentum — INITIATED só via webhook.)
      // ON CONFLICT: only sets acquisition_channel if currently NULL (first-touch wins).
      // F7.c (ADR-004): application_status removido.
      await this.db.query(
        `INSERT INTO worker_job_applications
           (worker_id, job_posting_id, source, acquisition_channel, application_funnel_stage)
         VALUES ($1, $2, 'manual', $3, 'INVITED')
         ON CONFLICT (worker_id, job_posting_id) DO UPDATE SET
           acquisition_channel = CASE
             WHEN worker_job_applications.acquisition_channel IS NULL THEN EXCLUDED.acquisition_channel
             ELSE worker_job_applications.acquisition_channel
           END,
           updated_at = NOW()`,
        [worker.id, jobPostingId, channel],
      );

      // Ensure encuadre exists so the worker appears in the Kanban INITIATED column.
      // Uses decrypted worker name. Only creates if no encuadre exists (preserves Talentum encuadres).
      const dedupHash = crypto.createHash('md5')
        .update(`social-link|${worker.id}|${jobPostingId}`)
        .digest('hex');

      await this.db.query(
        `INSERT INTO encuadres (worker_id, job_posting_id, worker_raw_name, worker_raw_phone, import_source_audit, dedup_hash)
         SELECT $1, $2, $4, $5, $6, $3
         WHERE NOT EXISTS (
           SELECT 1 FROM encuadres e WHERE e.worker_id = $1 AND e.job_posting_id = $2
         )
         ON CONFLICT (worker_id, job_posting_id) DO NOTHING`,
        [worker.id, jobPostingId, dedupHash, worker.name, worker.phone, channel],
      );

      res.status(200).json({ success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('[WorkerApplicationsController] trackChannel error:', message);
      res.status(500).json({ success: false, error: message });
    }
  }
}
