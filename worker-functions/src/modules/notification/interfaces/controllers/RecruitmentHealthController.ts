import { Request, Response } from 'express';
import { Pool } from 'pg';
import { logger, reportError } from '@shared/logging';

interface AutoInviteMetrics {
  vacancies_created: number;
  invites_enqueued: number;
  invites_sent: number;
  invites_delivered: number;
  invites_failed: number;
}

interface BulkDispatchMetrics {
  batch_id: string | null;
  total: number;
  sent: number;
  errors: number;
  started_at: string | null;
  finished_at: string | null;
}

interface HealthData {
  auto_invite_last_24h: AutoInviteMetrics;
  bulk_dispatch_incomplete_last_run: BulkDispatchMetrics;
  bulk_dispatch_talentum_last_run: BulkDispatchMetrics;
}

interface AutoInviteRow {
  vacancies_created: string;
  invites_enqueued: string;
  invites_sent: string;
  invites_delivered: string;
  invites_failed: string;
}

interface BulkDispatchRow {
  batch_id: string;
  total: string;
  sent: string;
  errors: string;
  started_at: string;
  finished_at: string;
}

/**
 * GET /api/admin/recruitment/health
 *
 * Retorna métricas dos fluxos de recrutamento das Fases 3, 4 e 5:
 *   - auto_invite_last_24h: convites automáticos pós-criação de vaga (Fase 3)
 *   - bulk_dispatch_incomplete_last_run: último batch do lembrete de cadastro incompleto (Fase 5)
 *   - bulk_dispatch_talentum_last_run: último batch do lembrete Talentum (Fase 4+5)
 */
export class RecruitmentHealthController {
  constructor(private readonly db: Pool) {}

  async getHealth(_req: Request, res: Response): Promise<void> {
    try {
      const [autoInvite, incompleteRun, talentumRun] = await Promise.all([
        this.queryAutoInvite24h(),
        this.queryLastBatch('complete_register_ofc'),
        this.queryLastBatch('talentum_incomplete_reminder'),
      ]);

      const data: HealthData = {
        auto_invite_last_24h: autoInvite,
        bulk_dispatch_incomplete_last_run: incompleteRun,
        bulk_dispatch_talentum_last_run: talentumRun,
      };

      res.status(200).json({ success: true, data });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error({ error: error.message }, 'RecruitmentHealthController.getHealth failed');
      reportError(error, { source: 'RecruitmentHealthController:getHealth' });
      res.status(500).json({ success: false, error: error.message });
    }
  }

  private async queryAutoInvite24h(): Promise<AutoInviteMetrics> {
    const { rows } = await this.db.query<AutoInviteRow>(`
      SELECT
        (SELECT COUNT(*)::text
         FROM domain_events
         WHERE event = 'vacancy.created'
           AND created_at > NOW() - INTERVAL '24 hours') AS vacancies_created,
        (SELECT COUNT(*)::text
         FROM messaging_outbox
         WHERE template_slug = 'vacancy_invited_auto'
           AND created_at > NOW() - INTERVAL '24 hours') AS invites_enqueued,
        (SELECT COUNT(*)::text
         FROM messaging_outbox
         WHERE template_slug = 'vacancy_invited_auto'
           AND status = 'sent'
           AND processed_at > NOW() - INTERVAL '24 hours') AS invites_sent,
        (SELECT COUNT(*)::text
         FROM messaging_outbox
         WHERE template_slug = 'vacancy_invited_auto'
           AND delivery_status = 'delivered'
           AND processed_at > NOW() - INTERVAL '24 hours') AS invites_delivered,
        (SELECT COUNT(*)::text
         FROM messaging_outbox
         WHERE template_slug = 'vacancy_invited_auto'
           AND status = 'failed'
           AND processed_at > NOW() - INTERVAL '24 hours') AS invites_failed
    `);

    const row = rows[0];
    return {
      vacancies_created: parseInt(row.vacancies_created, 10),
      invites_enqueued: parseInt(row.invites_enqueued, 10),
      invites_sent: parseInt(row.invites_sent, 10),
      invites_delivered: parseInt(row.invites_delivered, 10),
      invites_failed: parseInt(row.invites_failed, 10),
    };
  }

  private async queryLastBatch(templateSlug: string): Promise<BulkDispatchMetrics> {
    const { rows } = await this.db.query<BulkDispatchRow>(`
      SELECT
        batch_id::text                                  AS batch_id,
        COUNT(*)::text                                  AS total,
        COUNT(*) FILTER (WHERE status = 'sent')::text   AS sent,
        COUNT(*) FILTER (WHERE status = 'error')::text  AS errors,
        MIN(dispatched_at)::text                        AS started_at,
        MAX(dispatched_at)::text                        AS finished_at
      FROM whatsapp_bulk_dispatch_logs
      WHERE batch_id = (
        SELECT batch_id
        FROM whatsapp_bulk_dispatch_logs
        WHERE template_slug = $1
          AND batch_id IS NOT NULL
        ORDER BY dispatched_at DESC
        LIMIT 1
      )
      GROUP BY batch_id
    `, [templateSlug]);

    if (rows.length === 0) {
      return {
        batch_id: null,
        total: 0,
        sent: 0,
        errors: 0,
        started_at: null,
        finished_at: null,
      };
    }

    const row = rows[0];
    return {
      batch_id: row.batch_id,
      total: parseInt(row.total, 10),
      sent: parseInt(row.sent, 10),
      errors: parseInt(row.errors, 10),
      started_at: row.started_at,
      finished_at: row.finished_at,
    };
  }
}
