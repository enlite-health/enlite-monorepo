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
 * que não receberam o reminder 'talentum_incomplete_reminder' nos últimos 7 dias.
 *
 * Exclui workers desabilitados, sem telefone e contas de import.
 * Dedup via NOT EXISTS em whatsapp_bulk_dispatch_logs (janela 7 dias).
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
      SELECT 1
      FROM whatsapp_bulk_dispatch_logs wbdl
      WHERE wbdl.worker_id = w.id
        AND wbdl.template_slug = 'talentum_incomplete_reminder'
        AND wbdl.dispatched_at > NOW() - INTERVAL '7 days'
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
        const workerNameToken = await tokenService.generate(row.worker_id, 'worker_name');

        const sendResult = await this.messaging.sendWhatsApp({
          to: row.phone,
          templateSlug: TEMPLATE_SLUG,
          variables: { worker_name: workerNameToken },
        });

        const status = sendResult.isSuccess ? 'sent' : 'error';
        const externalId = sendResult.isSuccess ? sendResult.getValue()!.externalId : null;
        const errorMsg = sendResult.isFailure ? (sendResult.error ?? null) : null;

        if (sendResult.isSuccess) {
          sent++;
        } else {
          errors++;
          batchLogger.warn({ workerId: row.worker_id, error: errorMsg }, 'Falha ao enviar WhatsApp Talentum');
        }

        await this.db
          .query(
            `INSERT INTO whatsapp_bulk_dispatch_logs
               (worker_id, triggered_by, phone, template_slug, status, twilio_sid, error_message, batch_id, source)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'bulk')`,
            [row.worker_id, triggeredBy, row.phone, TEMPLATE_SLUG, status, externalId, errorMsg, batchId],
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
