import { Request, Response } from 'express';
import { Pool } from 'pg';
import { z } from 'zod';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { reportError } from '@shared/logging';
import {
  assertWorkerCanApply,
  WorkerNotEligibleError,
} from '../../domain/WorkerApplicationEligibility';
import { BlockedApplicationQueryRepository } from '../../infrastructure/BlockedApplicationQueryRepository';
import { deriveKanbanColumn, isMatchedNotInvited } from '../../domain/kanbanColumn';

/**
 * Papel opcional ao mover para SELECTED (feature "Equipe Armada").
 * TITULAR=titular, RAPID_RESPONSE=substituto. Ausente = fica pendente de
 * classificação (bucket PENDENTE_CLASSIFICACAO no dashboard de gestão).
 */
const encuadreRoleSchema = z.enum(['TITULAR', 'RAPID_RESPONSE']);


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
 *
 * Migration 230 (2026-06-26): Kanban redesign
 *   - INITIATED column removed (stage renamed to PRE_SCREENING in DB)
 *   - PRE_SCREENING column added (Talentum entry point)
 *   - INICIADO column added: INVITED+source='manual' WJAs
 *
 * Feature BLOQUEADO (2026-07-03): worker_blocked_applications cards moved out of
 * INICIADO into their own BLOQUEADO column — INICIADO is now real WJAs only.
 * Promoted (worker completed registration) blocked attempts stop appearing here
 * and become real WJA cards in INICIADO (see PromoteBlockedApplicationsUseCase).
 */
export class WJAFunnelController {
  private db: Pool;
  private blockedRepo: BlockedApplicationQueryRepository;

  constructor() {
    this.db = DatabaseConnection.getInstance().getPool();
    this.blockedRepo = new BlockedApplicationQueryRepository();
  }

  /**
   * GET /api/admin/vacancies/:id/funnel
   *
   * Returns all worker_job_applications for a vacancy grouped by funnel stage.
   * WJA is the primary source; encuadre is joined LATERAL (optional) to enrich
   * cards that already have one. Orphan WJAs (no encuadre) are now visible.
   *
   * Card identifier: wja.id (always present). encuadreId: e.id (null for orphans).
   *
   * Columns (Migration 230 + feature BLOQUEADO):
   *   INVITED    — WJA stage=INVITED, source != 'manual' (auto-invite system)
   *   BLOQUEADO  — worker_blocked_applications não promovidas (tentativa bloqueada)
   *   INICIADO   — WJA stage=INVITED + source='manual' (postulação real, não-bloqueada)
   *   PRE_SCREENING — WJA stage=PRE_SCREENING (antigo INITIATED)
   *   IN_PROGRESS, COMPLETED, CONFIRMED, SELECTED, REJECTED — inalterados
   */
  async getEncuadreFunnel(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const [result, blockedAttempts] = await Promise.all([
        this.db.query(
          `SELECT
             wja.id,
             wja.worker_id,
             w.first_name_encrypted,
             w.last_name_encrypted,
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
             wja.source,
             wja.messaged_at,
             CASE WHEN wja.source != 'talentum' OR wja.source IS NULL THEN NULL
               WHEN (SELECT tp.status FROM talentum_prescreenings tp WHERE tp.worker_id = wja.worker_id AND tp.job_posting_id = wja.job_posting_id ORDER BY tp.updated_at DESC LIMIT 1) = 'PENDING' THEN 'PENDING'
               ELSE wja.application_funnel_stage END AS talentum_status,
             (SELECT COUNT(*)::int FROM wja_contact_notes cn
              WHERE cn.worker_id = wja.worker_id AND cn.job_posting_id = wja.job_posting_id) AS contact_notes_count,
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
          [id],
        ),
        this.blockedRepo.listByVacancy(id),
      ]);

      // Colunas do Kanban — classificação 100% baseada em application_funnel_stage
      // Migration 230: INITIATED removido → PRE_SCREENING + INICIADO adicionados
      // Feature BLOQUEADO: worker_blocked_applications não promovidas ganham coluna própria
      const stages: Record<string, unknown[]> = {
        INVITED: [],
        BLOQUEADO: [],      // worker_blocked_applications não promovidas (badge)
        INICIADO: [],       // INVITED+source='manual' — postulação real, não-bloqueada
        PRE_SCREENING: [],  // Antigo INITIATED — entrou no formulário Talentum
        IN_PROGRESS: [],
        COMPLETED: [],      // agrupa COMPLETED + QUALIFIED + IN_DOUBT (tag diferencia)
        CONFIRMED: [],
        SELECTED: [],
        REJECTED: [],
      };

      const kms = new KMSEncryptionService();

      // Decrypt WJA names + blocked worker names em paralelo no controller (não no repo)
      const [decryptedWjaNames, decryptedBlockedNames] = await Promise.all([
        Promise.all(result.rows.map(async (row) => {
          const [firstName, lastName] = await Promise.all([
            row.first_name_encrypted ? kms.decrypt(row.first_name_encrypted).catch(() => null) : null,
            row.last_name_encrypted ? kms.decrypt(row.last_name_encrypted).catch(() => null) : null,
          ]);
          const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();
          if (fullName) return fullName;
          const wid = row.worker_id as string | null;
          return wid ? `Worker #${wid.slice(-8)}` : 'Worker sem identificação';
        })),
        Promise.all(blockedAttempts.map(async (ba): Promise<{ name: string | null; phone: string | null }> => {
          if (!ba.workerId) return { name: null, phone: null };
          // Fetch worker name (encrypted) + phone (plaintext — usado para dedup,
          // ver migrations/023_encrypt_all_pii.sql) para os cards bloqueados
          const workerRow = await this.db.query(
            `SELECT first_name_encrypted, last_name_encrypted, phone FROM workers WHERE id = $1`,
            [ba.workerId],
          );
          if (workerRow.rows.length === 0) return { name: null, phone: null };
          const wr = workerRow.rows[0];
          const [fn, ln] = await Promise.all([
            wr.first_name_encrypted ? kms.decrypt(wr.first_name_encrypted).catch(() => null) : null,
            wr.last_name_encrypted ? kms.decrypt(wr.last_name_encrypted).catch(() => null) : null,
          ]);
          const name = [fn, ln].filter(Boolean).join(' ').trim();
          return { name: name || null, phone: (wr.phone as string | null) ?? null };
        })),
      ]);

      // Classify WJA rows into kanban columns
      let classifiedCount = 0;
      for (let i = 0; i < result.rows.length; i++) {
        const row = result.rows[i];
        const stage = row.funnel_stage as string | null;
        const source = row.source as string | null;

        // AC2 (86ajb48v1): a system match that was never messaged is a match
        // candidate, not an invitation — running a match writes ALL top-N as
        // INVITED/system, so keeping them here inflates "Invitados". They live
        // only in the match modal until a real send sets messaged_at.
        if (isMatchedNotInvited(stage, source, row.messaged_at as string | Date | null)) {
          continue;
        }
        classifiedCount++;

        const item = {
          id: row.id,
          encuadreId: row.encuadre_id ?? null,
          workerId: row.worker_id ?? null,
          workerName: decryptedWjaNames[i],
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
          internalStage: stage ?? null,
          contactNotesCount: Number(row.contact_notes_count ?? 0),
        };

        // Classificação 100% baseada em (stage, source) — SSOT em deriveKanbanColumn
        // (domain/kanbanColumn.ts), compartilhado com a aba de encuadre do worker-detail.
        stages[deriveKanbanColumn(stage, source)].push(item);
      }

      // Merge blocked attempt cards into their own BLOQUEADO column (not promoted yet —
      // listByVacancy já faz NOT EXISTS contra worker_job_applications, então uma linha
      // promovida vira WJA real e some daqui automaticamente).
      for (let i = 0; i < blockedAttempts.length; i++) {
        const ba = blockedAttempts[i];
        const blockedWorker = decryptedBlockedNames[i];
        stages.BLOQUEADO.push({
          id: ba.id,
          encuadreId: null,
          workerId: ba.workerId ?? null,
          workerName: blockedWorker?.name ?? null,
          workerPhone: blockedWorker?.phone ?? null,
          occupation: null,
          interviewDate: null,
          interviewTime: null,
          meetLink: null,
          resultado: null,
          attended: null,
          rejectionReasonCategory: null,
          rejectionReason: null,
          matchScore: null,
          interviewResponse: null,
          acquisitionChannel: ba.acquisitionChannel,
          talentumStatus: null,
          workZone: null,
          redireccionamiento: null,
          internalStage: null,
          // Notas de contato escritas enquanto o card estava bloqueado
          // (migration 235 — chave estável worker_id+job_posting_id).
          contactNotesCount: ba.contactNotesCount,
          // Blocked-specific fields
          isBlocked: true,
          blockedReason: ba.blockedReason,
          missingFields: ba.missingFields,
          attemptCount: ba.attemptCount,
        });
      }

      res.json({
        success: true,
        data: {
          stages,
          totalEncuadres: classifiedCount, // WJAs shown on the board (excludes matched-not-invited system rows)
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
   *
   * Migration 230: INITIATED replaced by PRE_SCREENING in validStages.
   * INVITED added to validStages — "Invitados" is a droppable column in the kanban
   * (KanbanBoard DROPPABLE_STAGES); its omission here 400'd every drop into it.
   */
  async moveEncuadre(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { targetStage, rejectionReasonCategory, rejectionReason, role } = req.body;

      const validStages = [
        'INVITED', 'PRE_SCREENING', 'IN_PROGRESS', 'COMPLETED', 'QUALIFIED', 'IN_DOUBT',
        'CONFIRMED', 'SELECTED', 'REJECTED',
      ];

      if (!targetStage || !validStages.includes(targetStage)) {
        res.status(400).json({ success: false, error: `targetStage must be one of: ${validStages.join(', ')}` });
        return;
      }

      // Papel só é aceito ao selecionar; quando presente deve ser válido.
      let selectedRole: 'TITULAR' | 'RAPID_RESPONSE' | null = null;
      if (role !== undefined && role !== null) {
        const parsed = encuadreRoleSchema.safeParse(role);
        if (!parsed.success) {
          res.status(400).json({ success: false, error: "role must be one of: TITULAR, RAPID_RESPONSE" });
          return;
        }
        selectedRole = parsed.data;
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
        `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
         VALUES ($1, $2, $3, 'manual')
         ON CONFLICT (worker_id, job_posting_id) DO UPDATE SET
           application_funnel_stage = $3,
           updated_at = NOW()`,
        [workerId, jobPostingId, targetStage],
      );

      // 3. Sincronizar encuadre.resultado para estados terminais
      if (targetStage === 'SELECTED') {
        // Grava o papel quando informado; sem papel o COALESCE preserva o
        // existente (re-mover não apaga a classificação anterior). Encuadre
        // selecionado sem papel = PENDENTE_CLASSIFICACAO no dashboard.
        await this.db.query(
          `UPDATE encuadres SET resultado = 'SELECCIONADO', role = COALESCE($2, role), updated_at = NOW() WHERE id = $1`,
          [id, selectedRole],
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
