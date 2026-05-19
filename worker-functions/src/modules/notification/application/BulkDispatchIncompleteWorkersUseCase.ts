import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { IMessagingService } from '../domain/IMessagingService';
import { Result } from '@shared/utils/Result';
import { logger, reportError } from '@shared/logging';

const TEMPLATE_SLUG = 'complete_register_ofc';

// Intervalo entre envios para evitar bloqueio de número pelo WhatsApp/Twilio.
// Padrão: 1500ms. Sobreposto pela variável de ambiente BULK_DISPATCH_DELAY_MS.
const DEFAULT_DELAY_MS = 1500;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Workers com encuadre que ainda têm documentos ou perfil incompletos
// Dedup via NOT EXISTS em worker_reminder_state (slot por dia).
const INCOMPLETE_WORKERS_QUERY = `
  SELECT DISTINCT
    w.id,
    w.phone,
    w.status,
    w.profession,
    w.preferred_age_range,
    w.preferred_types,
    w.experience_types,
    wd.documents_status,
    CASE WHEN wd.resume_cv_url IS NULL THEN 'SIM' ELSE 'não' END AS falta_curriculo,
    CASE WHEN wd.identity_document_url IS NULL THEN 'SIM' ELSE 'não' END AS falta_rg_cpf,
    CASE WHEN wd.criminal_record_url IS NULL THEN 'SIM' ELSE 'não' END AS falta_antecedentes,
    CASE WHEN wd.professional_registration_url IS NULL THEN 'SIM' ELSE 'não' END AS falta_registro_prof,
    CASE WHEN wd.liability_insurance_url IS NULL THEN 'SIM' ELSE 'não' END AS falta_seguro,
    CASE WHEN w.sex_encrypted IS NULL THEN 'SIM' ELSE 'não' END AS falta_sexo,
    CASE WHEN w.first_name_encrypted IS NULL THEN 'SIM' ELSE 'não' END AS falta_nome,
    CASE WHEN w.profession IS NULL OR w.profession = '' THEN 'SIM' ELSE 'não' END AS falta_profissao,
    CASE WHEN w.preferred_age_range IS NULL OR w.preferred_age_range = '' THEN 'SIM' ELSE 'não' END AS falta_age_range,
    CASE WHEN w.preferred_types IS NULL OR w.preferred_types = '{}' THEN 'SIM' ELSE 'não' END AS falta_preferred_types,
    CASE WHEN w.experience_types IS NULL OR w.experience_types = '{}' THEN 'SIM' ELSE 'não' END AS falta_experience_types
  FROM workers w
  INNER JOIN encuadres e ON e.worker_id = w.id
  LEFT JOIN worker_documents wd ON wd.worker_id = w.id
  WHERE
    w.email NOT LIKE '%@enlite.import'
    AND w.phone IS NOT NULL
    AND w.phone <> ''
    AND (
      wd.documents_status IS NULL
      OR wd.documents_status NOT IN ('submitted', 'under_review', 'approved')
      OR w.sex_encrypted IS NULL
      OR w.first_name_encrypted IS NULL
      OR w.profession IS NULL OR w.profession = ''
      OR w.preferred_age_range IS NULL OR w.preferred_age_range = ''
      OR w.preferred_types IS NULL OR w.preferred_types = '{}'
      OR w.experience_types IS NULL OR w.experience_types = '{}'
    )
    AND NOT EXISTS (
      SELECT 1 FROM worker_reminder_state wrs
      WHERE wrs.worker_id = w.id
        AND wrs.template_slug = 'complete_register_ofc'
        AND wrs.sent_date = CURRENT_DATE
    )
  ORDER BY w.id
`;

export interface BulkDispatchDetail {
  workerId: string;
  phone: string;
  status: 'sent' | 'error';
  twilioSid?: string;
  error?: string;
}

export interface BulkDispatchResult {
  batchId: string;
  total: number;
  sent: number;
  errors: number;
  dryRun: boolean;
  details: BulkDispatchDetail[];
}

export interface BulkDispatchOptions {
  /** Se true, executa a query mas não chama o Twilio nem grava logs. */
  dryRun?: boolean;
  /** Limita o envio aos primeiros N workers (útil para testes pontuais). */
  limit?: number;
}

export class BulkDispatchIncompleteWorkersUseCase {
  constructor(
    private readonly db: Pool,
    private readonly messaging: IMessagingService,
  ) {}

  async execute(triggeredBy: string, opts: BulkDispatchOptions = {}): Promise<Result<BulkDispatchResult>> {
    const { dryRun = false, limit } = opts;
    const batchId = uuidv4();
    const batchLogger = logger.child({ batchId, triggeredBy });

    batchLogger.info('BulkDispatch iniciado');

    // 1. Busca workers com cadastro incompleto (já exclui quem recebeu hoje via NOT EXISTS)
    let rows: Array<{ id: string; phone: string }>;
    try {
      const queryResult = await this.db.query<{ id: string; phone: string }>(
        INCOMPLETE_WORKERS_QUERY,
      );
      rows = queryResult.rows;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return Result.fail<BulkDispatchResult>(
        `Erro ao consultar workers incompletos: ${msg}`,
      );
    }

    // Aplica limite se informado
    if (limit && limit > 0) {
      rows = rows.slice(0, limit);
    }

    batchLogger.info({ total: rows.length, dryRun }, 'Workers elegíveis para dispatch');

    // Dry-run: retorna quem receberia sem chamar Twilio nem gravar logs
    if (dryRun) {
      const details: BulkDispatchDetail[] = rows.map(row => ({
        workerId: row.id,
        phone: row.phone,
        status: 'sent' as const,
      }));
      return Result.ok<BulkDispatchResult>({
        batchId,
        total: rows.length,
        sent: 0,
        errors: 0,
        dryRun: true,
        details,
      });
    }

    const details: BulkDispatchDetail[] = [];
    const delayMs = parseInt(process.env.BULK_DISPATCH_DELAY_MS ?? '', 10) || DEFAULT_DELAY_MS;

    // 2. Dispara mensagem para cada worker e persiste o log
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];

      // Aguarda delay entre envios (não aplica antes do primeiro)
      if (i > 0) await sleep(delayMs);

      // 2a. Tentar adquirir slot atomic — garante idempotência em execuções paralelas
      let lockAcquired = false;
      try {
        const lockRes = await this.db.query<{ id: string }>(
          `INSERT INTO worker_reminder_state (worker_id, template_slug, sent_date, status, batch_id)
           VALUES ($1, $2, CURRENT_DATE, 'pending', $3)
           ON CONFLICT (worker_id, template_slug, sent_date) DO NOTHING
           RETURNING worker_id`,
          [row.id, TEMPLATE_SLUG, batchId],
        );

        if (lockRes.rows.length === 0) {
          // Outro processo já adquiriu o slot neste mesmo dia — skip
          batchLogger.info({ workerId: row.id }, 'Slot já adquirido por outro processo, skip');
          continue;
        }

        lockAcquired = true;
      } catch (err: unknown) {
        const e = err instanceof Error ? err : new Error(String(err));
        batchLogger.warn({ workerId: row.id, error: e.message }, 'Falha ao adquirir slot worker_reminder_state, skip');
        reportError(e, { source: 'BulkDispatch:acquireLock', workerId: row.id, batchId });
        continue;
      }

      // 2b. Enviar WhatsApp
      const sendResult = await this.messaging.sendWhatsApp({
        to: row.phone,
        templateSlug: TEMPLATE_SLUG,
      });

      const finalStatus = sendResult.isSuccess ? 'sent' : 'failed';

      const detail: BulkDispatchDetail = {
        workerId: row.id,
        phone: row.phone,
        status: sendResult.isSuccess ? 'sent' : 'error',
        twilioSid: sendResult.isSuccess ? sendResult.getValue()!.externalId : undefined,
        error: sendResult.isFailure ? sendResult.error : undefined,
      };

      details.push(detail);

      // 2c. Atualizar worker_reminder_state com resultado real
      if (lockAcquired) {
        await this.db.query(
          `UPDATE worker_reminder_state
           SET status = $1, updated_at = NOW()
           WHERE worker_id = $2 AND template_slug = $3 AND sent_date = CURRENT_DATE`,
          [finalStatus, row.id, TEMPLATE_SLUG],
        ).catch((err: unknown) => {
          const e = err instanceof Error ? err : new Error(String(err));
          batchLogger.warn({ workerId: row.id, error: e.message }, 'Falha update worker_reminder_state');
          reportError(e, { source: 'BulkDispatch:updateState', workerId: row.id, batchId });
        });
      }

      // 2d. Persiste log de auditoria — falhas de log são non-blocking
      await this.db
        .query(
          `INSERT INTO whatsapp_bulk_dispatch_logs
             (worker_id, triggered_by, phone, template_slug, status, twilio_sid, error_message, batch_id, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'bulk')`,
          [
            row.id,
            triggeredBy,
            row.phone,
            TEMPLATE_SLUG,
            detail.status,
            detail.twilioSid ?? null,
            detail.error ?? null,
            batchId,
          ],
        )
        .catch((err: Error) => {
          batchLogger.warn({ workerId: row.id, error: err.message }, 'Falha ao gravar log de dispatch');
        });
    }

    const sent = details.filter(d => d.status === 'sent').length;
    const errors = details.filter(d => d.status === 'error').length;

    batchLogger.info({ sent, errors }, 'BulkDispatch concluído');

    return Result.ok<BulkDispatchResult>({
      batchId,
      total: rows.length,
      sent,
      errors,
      dryRun: false,
      details,
    });
  }
}
