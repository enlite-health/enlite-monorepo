import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { IMessagingService } from '../domain/IMessagingService';
import { TokenService } from '../infrastructure/TokenService';
import { logger, reportError } from '@shared/logging';

const TEMPLATE_SLUG = 'talentum_incomplete_reminder';

// Intervalo entre envios para evitar bloqueio de número pelo WhatsApp/Twilio.
// Padrão: 1500ms. Sobreposto pela variável de ambiente BULK_DISPATCH_DELAY_MS.
const DEFAULT_DELAY_MS = 1500;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Workers com application_funnel_stage INITIATED ou IN_PROGRESS há >5 dias
 * que não receberam o reminder 'talentum_incomplete_reminder' hoje.
 *
 * Dedup via NOT EXISTS em worker_reminder_state (slot por dia).
 * Exclui workers desabilitados, sem telefone e contas de import.
 */
const TALENTUM_INCOMPLETE_QUERY = `
  SELECT DISTINCT
    w.id AS worker_id,
    w.phone AS phone
  FROM workers w
  INNER JOIN worker_job_applications wja
    ON wja.worker_id = w.id
    AND wja.application_funnel_stage IN ('INITIATED', 'IN_PROGRESS')
    AND wja.updated_at < NOW() - INTERVAL '5 days'
  WHERE
    w.status != 'DISABLED'
    AND w.phone IS NOT NULL
    AND w.phone <> ''
    AND w.email NOT LIKE '%@enlite.import'
    AND NOT EXISTS (
      SELECT 1 FROM worker_reminder_state wrs
      WHERE wrs.worker_id = w.id
        AND wrs.template_slug = 'talentum_incomplete_reminder'
        AND wrs.sent_date = CURRENT_DATE
    )
  ORDER BY w.id
`;

export interface BulkDispatchTalentumResult {
  batchId: string;
  total: number;
  sent: number;
  errors: number;
}

export class BulkDispatchTalentumIncompleteUseCase {
  constructor(
    private readonly db: Pool,
    private readonly messaging: IMessagingService,
  ) {}

  async execute(triggeredBy: string): Promise<BulkDispatchTalentumResult> {
    const batchId = uuidv4();
    const batchLogger = logger.child({ batchId, useCase: 'BulkDispatchTalentumIncomplete', triggeredBy });

    batchLogger.info({ msg: 'BulkDispatchTalentum iniciado' });

    const rows = await this.db.query<{ worker_id: string; phone: string }>(TALENTUM_INCOMPLETE_QUERY);

    batchLogger.info({ msg: 'Workers elegíveis para reminder Talentum', total: rows.rows.length });

    const delayMs = parseInt(process.env.BULK_DISPATCH_DELAY_MS ?? '', 10) || DEFAULT_DELAY_MS;
    const tokenService = new TokenService(this.db);

    let sent = 0;
    let errors = 0;

    for (let i = 0; i < rows.rows.length; i++) {
      const row = rows.rows[i];

      // Aguarda delay entre envios (não aplica antes do primeiro)
      if (i > 0) await sleep(delayMs);

      try {
        // 1. Tentar adquirir slot atomic — garante idempotência em execuções paralelas
        const lockRes = await this.db.query<{ worker_id: string }>(
          `INSERT INTO worker_reminder_state (worker_id, template_slug, sent_date, status, batch_id)
           VALUES ($1, $2, CURRENT_DATE, 'pending', $3)
           ON CONFLICT (worker_id, template_slug, sent_date) DO NOTHING
           RETURNING worker_id`,
          [row.worker_id, TEMPLATE_SLUG, batchId],
        );

        if (lockRes.rows.length === 0) {
          // Outro processo já adquiriu o slot neste mesmo dia — skip
          batchLogger.info({ workerId: row.worker_id }, 'Slot já adquirido por outro processo, skip');
          continue;
        }

        // 2. Gerar token de nome e enviar WhatsApp
        const workerNameToken = await tokenService.generate(row.worker_id, 'worker_name');

        const sendResult = await this.messaging.sendWhatsApp({
          to: row.phone,
          templateSlug: TEMPLATE_SLUG,
          variables: { worker_name: workerNameToken },
        });

        const finalStatus = sendResult.isSuccess ? 'sent' : 'failed';
        const externalId = sendResult.isSuccess ? sendResult.getValue()!.externalId : null;
        const errorMsg = sendResult.isFailure ? (sendResult.error ?? null) : null;

        if (sendResult.isSuccess) {
          sent++;
        } else {
          errors++;
          batchLogger.warn({ workerId: row.worker_id, error: errorMsg }, 'Falha ao enviar WhatsApp Talentum');
        }

        // 3. Atualizar worker_reminder_state com resultado real
        await this.db.query(
          `UPDATE worker_reminder_state
           SET status = $1, updated_at = NOW()
           WHERE worker_id = $2 AND template_slug = $3 AND sent_date = CURRENT_DATE`,
          [finalStatus, row.worker_id, TEMPLATE_SLUG],
        ).catch((err: unknown) => {
          const e = err instanceof Error ? err : new Error(String(err));
          batchLogger.warn({ workerId: row.worker_id, error: e.message }, 'Falha update worker_reminder_state');
          reportError(e, { source: 'BulkDispatchTalentum:updateState', workerId: row.worker_id, batchId });
        });

        // 4. Gravar log de auditoria em whatsapp_bulk_dispatch_logs
        await this.db
          .query(
            `INSERT INTO whatsapp_bulk_dispatch_logs
               (worker_id, triggered_by, phone, template_slug, status, twilio_sid, error_message, batch_id, source)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'bulk')`,
            [row.worker_id, triggeredBy, row.phone, TEMPLATE_SLUG, finalStatus === 'sent' ? 'sent' : 'error', externalId, errorMsg, batchId],
          )
          .catch((err: unknown) => {
            const e = err instanceof Error ? err : new Error(String(err));
            batchLogger.warn({ workerId: row.worker_id, error: e.message }, 'Falha ao gravar log de dispatch Talentum');
            reportError(e, { source: 'BulkDispatchTalentum:log', workerId: row.worker_id, batchId });
          });
      } catch (err) {
        errors++;
        const e = err instanceof Error ? err : new Error(String(err));
        batchLogger.warn({ workerId: row.worker_id, error: e.message }, 'Erro ao processar worker Talentum');
        reportError(e, { source: 'BulkDispatchTalentum:perWorker', workerId: row.worker_id, batchId });
      }
    }

    batchLogger.info({ msg: 'BulkDispatchTalentum concluído', total: rows.rows.length, sent, errors });

    return { batchId, total: rows.rows.length, sent, errors };
  }
}
