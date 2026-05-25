import { Request, Response } from 'express';
import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { reportError } from '@shared/logging';
import {
  assertWorkerCanApply,
  WorkerNotEligibleError,
} from '../../domain/WorkerApplicationEligibility';


/**
 * WJAFunnelController
 *
 * Kanban funnel endpoints for vacancy WJA management.
 * Dashboard endpoints (coordinator-capacity, alerts, conversion-by-channel)
 * live in EncuadreDashboardController.
 *
 * - GET  /api/admin/vacancies/:id/funnel  — WJAs grouped by stage
 * - PUT  /api/admin/encuadres/:id/move    — move WJA in kanban
 *
 * Renamed from EncuadreFunnelController in F7.a (migration 194).
 * WJA is the canonical entity; encuadre is enrichment data only.
 */
export class WJAFunnelController {
  private db: Pool;

  constructor() {
    this.db = DatabaseConnection.getInstance().getPool();
  }

  /**
   * GET /api/admin/vacancies/:id/funnel
   *
   * Returns all worker_job_applications for a vacancy grouped by funnel stage.
   * WJA is the primary source; encuadre is joined LATERAL (optional) to enrich
   * cards that already have one. Orphan WJAs (no encuadre) are now visible.
   *
   * Card identifier: wja.id (always present). encuadreId: e.id (null for orphans).
   */
  async getEncuadreFunnel(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const result = await this.db.query(
        `SELECT
           wja.id,
           wja.worker_id,
           COALESCE(e.worker_raw_name, w.first_name_encrypted) AS worker_name,
           COALESCE(w.phone, e.worker_raw_phone) AS worker_phone,
           e.occupation_raw,
           COALESCE((wja.interview_datetime AT TIME ZONE 'UTC')::date, e.interview_date) AS interview_date,
           COALESCE((wja.interview_datetime AT TIME ZONE 'UTC')::time, e.interview_time) AS interview_time,
           COALESCE(wja.interview_meet_link, e.meet_link) AS meet_link,
           e.resultado,
           e.attended,
           e.rejection_reason_category,
           e.rejection_reason,
           e.redireccionamiento,
           e.id AS encuadre_id,
           wja.match_score,
           wja.interview_response,
           wja.acquisition_channel,
           wja.application_funnel_stage AS funnel_stage,
           CASE WHEN wja.source != 'talentum' OR wja.source IS NULL THEN NULL
             WHEN (SELECT tp.status FROM talentum_prescreenings tp WHERE tp.worker_id = wja.worker_id AND tp.job_posting_id = wja.job_posting_id ORDER BY tp.updated_at DESC LIMIT 1) = 'PENDING' THEN 'PENDING'
             ELSE wja.application_funnel_stage END AS talentum_status,
           wsa.work_zone
         FROM worker_job_applications wja
         LEFT JOIN workers w ON w.id = wja.worker_id
         LEFT JOIN LATERAL (
           SELECT id, worker_raw_name, worker_raw_phone, occupation_raw,
                  interview_date, interview_time, meet_link, resultado, attended,
                  rejection_reason_category, rejection_reason, redireccionamiento
           FROM encuadres
           WHERE worker_id = wja.worker_id AND job_posting_id = wja.job_posting_id
           ORDER BY created_at DESC
           LIMIT 1
         ) e ON true
         LEFT JOIN worker_service_areas wsa ON wsa.worker_id = wja.worker_id AND wsa.deleted_at IS NULL
         WHERE wja.job_posting_id = $1
         ORDER BY wja.updated_at DESC NULLS LAST, wja.created_at DESC`,
        [id]
      );

      // Colunas do Kanban — classificação 100% baseada em application_funnel_stage
      const stages: Record<string, unknown[]> = {
        INVITED: [],
        INITIATED: [],
        IN_PROGRESS: [],
        COMPLETED: [],     // agrupa COMPLETED + QUALIFIED + IN_DOUBT (tag diferencia). NOT_QUALIFIED foi auto-rejeitado em F3 (migration 191)
        CONFIRMED: [],
        SELECTED: [],      // PLACED removido em F7.a (migration 194 — 0 linhas em prod, sync F6 morta)
        REJECTED: [],
      };

      for (const row of result.rows) {
        const stage = row.funnel_stage as string | null;

        const item = {
          id: row.id,
          encuadreId: row.encuadre_id ?? null,
          workerId: row.worker_id ?? null,
          workerName: row.worker_name,
          workerPhone: row.worker_phone,
          occupation: row.occupation_raw,
          interviewDate: row.interview_date,
          interviewTime: row.interview_time,
          meetLink: row.meet_link,
          resultado: row.resultado,
          attended: row.attended,
          rejectionReasonCategory: row.rejection_reason_category,
          rejectionReason: row.rejection_reason,
          matchScore: row.match_score,
          interviewResponse: row.interview_response ?? null,
          acquisitionChannel: row.acquisition_channel ?? null,
          talentumStatus: row.talentum_status ?? null,
          workZone: row.work_zone,
          redireccionamiento: row.redireccionamiento,
          funnelStage: stage ?? null,
          internalStage: stage ?? null, // alias explícito; frontend usa pra renderizar badge
        };

        // Classificação direta por application_funnel_stage
        if (stage === 'SELECTED') {
          stages.SELECTED.push(item);
        } else if (stage === 'REJECTED') {
          stages.REJECTED.push(item);
        } else if (stage === 'CONFIRMED') {
          stages.CONFIRMED.push(item);
        } else if (stage !== null && ['COMPLETED', 'QUALIFIED', 'IN_DOUBT'].includes(stage)) {
          // REPROGRAM removido em F7.b — workers em CONFIRMED+awaiting_reschedule aparecem na coluna CONFIRMED
          stages.COMPLETED.push(item);
        } else if (stage === 'IN_PROGRESS') {
          stages.IN_PROGRESS.push(item);
        } else if (stage === 'INITIATED') {
          stages.INITIATED.push(item);
        } else if (stage === 'INVITED' || !stage) {
          stages.INVITED.push(item);
        } else {
          stages.INVITED.push(item); // fallback for unknown stages
        }
      }

      res.json({
        success: true,
        data: {
          stages,
          totalEncuadres: result.rows.length, // kept for backward-compat; equals total WJAs now
        },
      });
    } catch (error) {
      const e = error instanceof Error ? error : new Error(String(error));
      reportError(e, { source: 'WJAFunnelController:getEncuadreFunnel' });
      res.status(500).json({ success: false, error: e.message });
    }
  }

  /**
   * PUT /api/admin/encuadres/:id/move
   *
   * Moves encuadre to a new Kanban column by updating application_funnel_stage.
   * Also syncs encuadre.resultado for terminal states (SELECTED/REJECTED).
   *
   * Body: { targetStage, rejectionReasonCategory?, rejectionReason? }
   */
  async moveEncuadre(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { targetStage, rejectionReasonCategory, rejectionReason } = req.body;

      const validStages = [
        'INITIATED', 'IN_PROGRESS', 'COMPLETED', 'QUALIFIED', 'IN_DOUBT',
        'CONFIRMED', 'SELECTED', 'REJECTED',
      ];

      if (!targetStage || !validStages.includes(targetStage)) {
        res.status(400).json({ success: false, error: `targetStage must be one of: ${validStages.join(', ')}` });
        return;
      }

      // 1. Busca encuadre para obter worker_id + job_posting_id
      const encuadre = await this.db.query(
        `SELECT worker_id, job_posting_id FROM encuadres WHERE id = $1`,
        [id],
      );
      if (encuadre.rowCount === 0) {
        res.status(404).json({ success: false, error: 'Encuadre not found' });
        return;
      }

      const { worker_id: workerId, job_posting_id: jobPostingId } = encuadre.rows[0];
      if (!workerId || !jobPostingId) {
        res.status(400).json({ success: false, error: 'Encuadre has no linked worker or job posting' });
        return;
      }

      try {
        await assertWorkerCanApply(this.db, workerId);
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

      // 2. Atualizar application_funnel_stage (fonte de verdade)
      await this.db.query(
        `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, application_status, source)
         VALUES ($1, $2, $3, 'applied', 'manual')
         ON CONFLICT (worker_id, job_posting_id) DO UPDATE SET
           application_funnel_stage = $3,
           updated_at = NOW()`,
        [workerId, jobPostingId, targetStage],
      );

      // 3. Sincronizar encuadre.resultado para estados terminais
      if (targetStage === 'SELECTED') {
        await this.db.query(
          `UPDATE encuadres SET resultado = 'SELECCIONADO', updated_at = NOW() WHERE id = $1`,
          [id],
        );
      } else if (targetStage === 'REJECTED') {
        await this.db.query(
          `UPDATE encuadres SET resultado = 'RECHAZADO',
             rejection_reason_category = COALESCE($2, rejection_reason_category),
             rejection_reason = COALESCE($3, rejection_reason),
             updated_at = NOW()
           WHERE id = $1`,
          [id, rejectionReasonCategory ?? null, rejectionReason ?? null],
        );
      }

      res.json({ success: true, data: { encuadreId: id, targetStage } });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      const status = message.includes('not found') ? 404 : 500;
      res.status(status).json({ success: false, error: message });
    }
  }
}
