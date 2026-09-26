import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { IMessagingService } from '../domain/IMessagingService';
import { CadencePolicy } from '../domain/CadencePolicy';
import { Result } from '@shared/utils/Result';
import { logger, reportError } from '@shared/logging';
import { excludeDisabledWorkersSql } from '@shared/database/activeWorkerFilter';
import {
  WorkerMessageAuditRepository,
  isWorkerStatusAtDispatch,
  isDocumentsStatusAtDispatch,
} from '@shared/messaging/WorkerMessageAuditRepository';
import { classifyMessagingFailureReason } from '../domain/messagingFailureReason';

const TEMPLATE_SLUG = 'complete_register_ofc';

const DEFAULT_DELAY_MS = 1500;

// Cadência combinada: envio inicial, +3 dias o 2º, +7 dias o 3º, e para (cap 3).
// Meta penaliza números que enviam repetidamente para quem não responde — a
// ausência dessa cadência (reenvio em dias consecutivos) causou o flag de spam.
// Ver docs/INCIDENT_WHATSAPP_SPAM.md no triage-service.
const CADENCE = new CadencePolicy([3, 7]);

// Workers com 3+ mensagens undelivered recentes são excluídos —
// indicam número bloqueado/inativo, continuar piora a reputação.
const UNDELIVERED_THRESHOLD = 3;

// FREEZE do incidente de spam: workers já contatados com este template ANTES
// desta data (encerramento do incidente) NÃO são recontatados — eram a coorte
// que recebeu a mensagem repetidamente. Workers novos seguem a CADENCE acima.
const INCIDENT_FREEZE_CUTOFF = '2026-06-02T00:00:00Z';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const INCOMPLETE_WORKERS_QUERY = `
  WITH send_stats AS (
    SELECT worker_id,
           COUNT(*) FILTER (WHERE status = 'sent') AS total_sent,
           MAX(dispatched_at) FILTER (WHERE status = 'sent') AS last_sent_at
    FROM whatsapp_bulk_dispatch_logs
    WHERE template_slug = '${TEMPLATE_SLUG}'
    GROUP BY worker_id
  ),
  undelivered_stats AS (
    SELECT worker_id,
           COUNT(*) AS undelivered_count
    FROM whatsapp_bulk_dispatch_logs
    WHERE delivery_status = 'undelivered'
      AND dispatched_at > NOW() - INTERVAL '30 days'
    GROUP BY worker_id
  )
  SELECT DISTINCT
    w.id,
    w.phone,
    w.messaging_channel,
    w.status,
    wd.documents_status
  FROM workers w
  INNER JOIN encuadres e ON e.worker_id = w.id
  LEFT JOIN worker_documents wd ON wd.worker_id = w.id
  LEFT JOIN send_stats ss ON ss.worker_id = w.id
  LEFT JOIN undelivered_stats us ON us.worker_id = w.id
  WHERE
    w.email NOT LIKE '%@enlite.import'
    AND w.phone IS NOT NULL
    AND w.phone <> ''
    -- Reforço explícito (belt-and-suspenders): o NOT EXISTS de messaging_opt_out
    -- abaixo já cobre quem foi desativado via DeactivateWorkerAccountUseCase ou
    -- pelo arquivamento em massa (D103), mas a baixa manual via
    -- PUT /workers/:id/status não grava opt-out — sem este filtro, esse worker
    -- continuaria elegível ao disparo em massa.
    AND ${excludeDisabledWorkersSql('w')}
    AND (
      wd.documents_status IS NULL
      OR wd.documents_status NOT IN ('submitted', 'under_review', 'approved')
      OR w.sex_encrypted IS NULL
      OR w.first_name_encrypted IS NULL
      OR w.profession IS NULL OR w.profession = ''
      OR w.preferred_age_range IS NULL OR w.preferred_age_range = '{}'::text[]
      OR w.preferred_types IS NULL OR w.preferred_types = '{}'::text[]
      OR w.experience_types IS NULL OR w.experience_types = '{}'::text[]
    )
    -- Dedup: não enviar se já recebeu hoje
    AND NOT EXISTS (
      SELECT 1 FROM worker_reminder_state wrs
      WHERE wrs.worker_id = w.id
        AND wrs.template_slug = '${TEMPLATE_SLUG}'
        AND wrs.sent_date = CURRENT_DATE
    )
    -- Cadência (1º envio → +3d → +7d → para; cap ${CADENCE.maxSends}). Sem reenvio em dias consecutivos.
    AND ${CADENCE.toSqlEligibility('COALESCE(ss.total_sent, 0)', 'ss.last_sent_at')}
    -- Excluir números com 3+ undelivered (bloqueado/inativo)
    AND COALESCE(us.undelivered_count, 0) < ${UNDELIVERED_THRESHOLD}
    -- Excluir opt-out
    AND NOT EXISTS (
      SELECT 1 FROM messaging_opt_out moo
      WHERE moo.worker_id = w.id AND moo.opted_in_at IS NULL
    )
    -- FREEZE do incidente de spam: não recontatar quem já recebeu este template
    -- antes do encerramento do incidente (ver INCIDENT_FREEZE_CUTOFF).
    AND NOT EXISTS (
      SELECT 1 FROM whatsapp_bulk_dispatch_logs frz
      WHERE frz.worker_id = w.id
        AND frz.template_slug = '${TEMPLATE_SLUG}'
        AND frz.dispatched_at < '${INCIDENT_FREEZE_CUTOFF}'
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
  private readonly auditRepo = new WorkerMessageAuditRepository();

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
    let rows: Array<{ id: string; phone: string; messaging_channel: string | null; status: string | null; documents_status: string | null }>;
    try {
      const queryResult = await this.db.query<{ id: string; phone: string; messaging_channel: string | null; status: string | null; documents_status: string | null }>(
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

      // 2b. Enviar WhatsApp — channel resolvido pelo messaging_channel do worker
      // (zero query extra: já veio na eligibility query acima).
      const sendResult = await this.messaging.sendWhatsApp({
        to: row.phone,
        templateSlug: TEMPLATE_SLUG,
        channel: row.messaging_channel === 'periskope' ? 'periskope' : 'twilio',
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

      // 2d. Persiste log de auditoria — falhas de log são non-blocking.
      // phone = NULL sempre (migration 475, mensageria-pii-e-retencao): row.phone segue sendo lido
      // (usado para o envio acima), só não é mais gravado neste log.
      await this.db
        .query(
          `INSERT INTO whatsapp_bulk_dispatch_logs
             (worker_id, triggered_by, phone, template_slug, status, twilio_sid, error_message, batch_id, source)
           VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, 'bulk')`,
          [
            row.id,
            triggeredBy,
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

      // 2e. Auditoria de DECISÃO (worker_message_audit, migration 474) — disparo SÍNCRONO
      // (não enfileira), por isso outcome é 'sent'/'failed', nunca 'queued'. worker_status e
      // documents_status reaproveitam a MESMA linha já lida na query de elegibilidade acima
      // (INCOMPLETE_WORKERS_QUERY) — nenhuma consulta nova.
      await this.auditRepo.record(this.db, {
        workerId: row.id,
        templateSlug: TEMPLATE_SLUG,
        channel: row.messaging_channel === 'periskope' ? 'periskope' : 'twilio',
        source: 'bulk',
        actorUid: triggeredBy,
        workerStatusAtDispatch: isWorkerStatusAtDispatch(row.status) ? row.status : null,
        documentsStatusAtDispatch: isDocumentsStatusAtDispatch(row.documents_status) ? row.documents_status : null,
        outcome: detail.status === 'sent' ? 'sent' : 'failed',
        // Achado do gate 25/09: `detail.error` é a string CRUA do provider (Twilio/Periskope) —
        // pode carregar o telefone do worker (ver TwilioMessagingService.ts:116,
        // PeriskopeMessagingService.ts:79-80). worker_message_audit (migration 474) tem garantia
        // explícita de nunca ter PII (COMMENT ON TABLE) — grava um CÓDIGO estável, nunca o texto.
        skipReason: detail.error ? classifyMessagingFailureReason(detail.error) : null,
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
