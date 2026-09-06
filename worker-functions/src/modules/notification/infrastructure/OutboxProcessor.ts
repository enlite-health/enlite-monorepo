import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { IMessagingService } from '../domain/IMessagingService';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { TokenService } from './TokenService';
import { PERISKOPE_PAUSED_ERROR } from './RoutingMessagingService';
import { loggingAls, logger, reportError } from '@shared/logging';
import { optedOutExistsSql } from '@shared/database/messagingOptOutFilter';

const MAX_ATTEMPTS = 3;
const BATCH_SIZE = 50;
const MAX_PENDING_AGE_DAYS = 7;

interface OutboxRow {
  id: string;
  worker_id: string;
  job_posting_id: string | null;
  template_slug: string;
  variables: Record<string, string>;
  attempts: number;
  trace_id: string | null;
}

/**
 * Processa registros pending em messaging_outbox, enviando via IMessagingService.
 *
 * Dois modos de execução:
 *   - processById(outboxId): processa 1 mensagem (chamado via Pub/Sub push)
 *   - processBatch(): processa batch de pending (safety net via Cloud Scheduler)
 *
 * Estratégia de retry: máximo MAX_ATTEMPTS tentativas por mensagem.
 * Após MAX_ATTEMPTS falhas consecutivas, o registro fica com status='failed'.
 */
export class OutboxProcessor {
  private encryptionService: KMSEncryptionService;
  private tokenService: TokenService;

  constructor(
    private readonly messaging: IMessagingService,
    private readonly db: Pool,
  ) {
    this.encryptionService = new KMSEncryptionService();
    this.tokenService = new TokenService(db);
  }

  /**
   * Processa uma única mensagem pelo ID (chamado via Pub/Sub push).
   * Retorna silenciosamente se a mensagem não existir ou já foi processada.
   */
  async processById(outboxId: string): Promise<void> {
    // TD-024: filtro de idade também no processById — se Pub/Sub push entregar
    // ID de row stale (improvável mas possível), não processa.
    const result = await this.db.query<OutboxRow>(
      `SELECT id, worker_id, job_posting_id, template_slug, variables, attempts, trace_id
       FROM messaging_outbox
       WHERE id = $1
         AND status = 'pending'
         AND attempts < $2
         AND created_at > NOW() - ($3::text || ' days')::interval
       LIMIT 1`,
      [outboxId, MAX_ATTEMPTS, MAX_PENDING_AGE_DAYS],
    );
    if (result.rows.length === 0) return;
    const row = result.rows[0];
    await loggingAls.run(
      { traceId: row.trace_id ?? uuidv4(), workerId: row.worker_id },
      () => this.processOne(row),
    );
  }

  /** Processa um batch de registros pending. Pode ser chamado diretamente nos testes. */
  async processBatch(): Promise<void> {
    // TD-023: auto-expire stale pending antes de processar (defesa contra
    // mensagens que ficaram presas por dias/semanas e perderam relevância).
    await this.markStalePendingAsFailed();

    const rows = await this.fetchPending();
    if (rows.length === 0) return;

    for (const row of rows) {
      await loggingAls.run(
        { traceId: row.trace_id ?? uuidv4(), workerId: row.worker_id },
        () => this.processOne(row),
      );
    }
  }

  /**
   * Marca como 'failed' qualquer outbox row em 'pending' há mais de
   * MAX_PENDING_AGE_DAYS dias. Previne re-envio de mensagens stale quando
   * o sweep roda após período de inatividade do processor.
   */
  private async markStalePendingAsFailed(): Promise<void> {
    const result = await this.db.query<{ id: string }>(
      `UPDATE messaging_outbox
       SET status = 'failed',
           error = 'auto-failed: pending exceeded ' || $1::text || ' days',
           processed_at = NOW()
       WHERE status = 'pending'
         AND created_at < NOW() - ($1::text || ' days')::interval
       RETURNING id`,
      [MAX_PENDING_AGE_DAYS],
    );
    if (result.rowCount && result.rowCount > 0) {
      logger.warn(
        { count: result.rowCount, maxAgeDays: MAX_PENDING_AGE_DAYS },
        'OutboxProcessor: stale pending rows auto-failed',
      );
    }
  }

  private async fetchPending(): Promise<OutboxRow[]> {
    // TD-024: defesa em profundidade — mesmo se markStalePendingAsFailed
    // não rodou (ex: processById direto), nunca processar rows muito velhas.
    const result = await this.db.query<OutboxRow>(
      `SELECT id, worker_id, job_posting_id, template_slug, variables, attempts, trace_id
       FROM messaging_outbox
       WHERE status = 'pending'
         AND attempts < $1
         AND created_at > NOW() - ($3::text || ' days')::interval
       ORDER BY created_at
       LIMIT $2`,
      [MAX_ATTEMPTS, BATCH_SIZE, MAX_PENDING_AGE_DAYS],
    );
    return result.rows;
  }

  private async processOne(row: OutboxRow): Promise<void> {
    // Busca telefone do worker (prefere whatsapp_phone_encrypted, fallback para phone) +
    // messaging_channel do worker CANÔNICO: se este worker foi mesclado
    // (merged_into_id aponta pra outro), o canal que vale é o do worker
    // sobrevivente (w2), nunca o do registro mesclado (w1) — gap apontado
    // pelo Architect: sem o COALESCE, um worker mesclado sempre resolveria
    // como 'twilio' (default da coluna), mesmo que o canônico já tenha
    // passado pelo handover.
    // Busca telefone/canal + flag de opt-out numa query só (evita round-trip extra
    // por mensagem). opted_out = existe supressão ATIVA (opted_in_at IS NULL) pro worker.
    const workerResult = await this.db.query<{
      whatsapp_phone_encrypted: string | null;
      phone: string | null;
      messaging_channel: string | null;
      opted_out: boolean;
      is_test: boolean;
    }>(
      `SELECT w1.whatsapp_phone_encrypted, w1.phone,
              COALESCE(w2.messaging_channel, w1.messaging_channel) AS messaging_channel,
              ${optedOutExistsSql('w1.id')} AS opted_out,
              COALESCE(w1.is_test, false) AS is_test
       FROM workers w1
       LEFT JOIN workers w2 ON w2.id = w1.merged_into_id
       WHERE w1.id = $1
       LIMIT 1`,
      [row.worker_id],
    );

    if (workerResult.rows.length === 0) {
      await this.markFailed(row.id, row.attempts, 'Worker não encontrado');
      return;
    }

    const { whatsapp_phone_encrypted, phone, messaging_channel, opted_out, is_test } = workerResult.rows[0];

    // --- Guard de is_test (mesmo ponto único de defesa, ANTES do opt-out) ---
    // Fixture de teste em produção NÃO pode virar mensagem real. Até aqui `is_test`
    // segregava seleção e matchmaking, mas o envio final — comum a TODAS as campanhas —
    // não olhava a marca: uma vez na `messaging_outbox`, a linha saía e a Twilio cobrava.
    // Mesma classe do furo de opt-out (2026-07-10), um andar acima.
    //
    // Vem ANTES do opt-out de propósito: fixture não deve consumir nem a checagem de
    // supressão. Marca 'suppressed' (não 'failed') para não poluir métrica de entrega
    // nem gastar tentativa de retry — e é o que a regressão do `e2e-prod` afirma para
    // provar o fluxo inteiro SEM enviar nada.
    if (is_test) {
      logger.info(
        { outboxId: row.id, workerId: row.worker_id },
        'OutboxProcessor: worker is_test, envio bloqueado (suppressed)',
      );
      await this.db.query(
        `UPDATE messaging_outbox
         SET status = 'suppressed',
             error = 'suppressed: is_test fixture',
             processed_at = NOW()
         WHERE id = $1`,
        [row.id],
      );
      return;
    }

    // --- Guard de opt-out (ponto ÚNICO de defesa antes de QUALQUER envio) ---
    // Fecha o furo do incidente 2026-07-10: a seleção de algumas campanhas checava
    // opt-out, mas o envio final (comum a TODAS — convite de vaga, lembrete de
    // entrevista, bulk) NÃO checava. Marca 'suppressed' (não 'failed') pra não
    // poluir métrica de falha de entrega nem consumir tentativa de retry.
    if (opted_out) {
      logger.info(
        { outboxId: row.id, workerId: row.worker_id },
        'OutboxProcessor: worker em opt-out, envio bloqueado (suppressed)',
      );
      await this.db.query(
        `UPDATE messaging_outbox
         SET status = 'suppressed',
             error = 'suppressed: worker opted out',
             processed_at = NOW()
         WHERE id = $1`,
        [row.id],
      );
      return;
    }

    const whatsappPhone = whatsapp_phone_encrypted
      ? await this.encryptionService.decrypt(whatsapp_phone_encrypted)
      : null;
    const to = whatsappPhone || phone;

    if (!to) {
      await this.markFailed(row.id, row.attempts, 'Worker sem telefone cadastrado');
      return;
    }

    const channel: 'twilio' | 'periskope' = messaging_channel === 'periskope' ? 'periskope' : 'twilio';

    // Guardrail de pacing: teto diário de envios Periskope (parte b/c do parecer).
    // Só consultado quando o canal é periskope — canal twilio nunca paga esse custo extra.
    if (channel === 'periskope' && (await this.isPeriskopeDailyCapReached())) {
      logger.warn(
        { outboxId: row.id, workerId: row.worker_id },
        'OutboxProcessor: teto diário Periskope atingido, mensagem fica pending (retry futuro)',
      );
      return;
    }

    // Resolve tokens PII (tk_*) para valores reais antes do envio
    const resolvedVariables = await this.tokenService.resolveVariables(row.variables ?? {});

    const result = await this.messaging.sendWhatsApp({
      to,
      templateSlug: row.template_slug,
      variables: resolvedVariables,
      channel,
    });

    if (result.isFailure) {
      // Canal pausado no kill-switch: falha reprocessável, NÃO consome tentativa
      // nem marca failed — o outbox trata como retry futuro (parecer do Architect).
      if (result.error === PERISKOPE_PAUSED_ERROR) {
        logger.info(
          { outboxId: row.id, workerId: row.worker_id },
          'OutboxProcessor: canal periskope pausado, mensagem fica pending (retry futuro)',
        );
        return;
      }

      const newAttempts = row.attempts + 1;
      const isFinal = newAttempts >= MAX_ATTEMPTS;
      await this.db.query(
        `UPDATE messaging_outbox
         SET attempts = $1,
             status = $2,
             error = $3,
             processed_at = NOW()
         WHERE id = $4`,
        [newAttempts, isFinal ? 'failed' : 'pending', result.error, row.id],
      );
      if (isFinal) {
        logger.warn({ outboxId: row.id, error: result.error }, 'OutboxProcessor falha definitiva');
        // Log final failure in dispatch audit table — best-effort
        await this.db.query(
          `INSERT INTO whatsapp_bulk_dispatch_logs
             (worker_id, job_posting_id, triggered_by, phone, template_slug, status, error_message, source)
           VALUES ($1, $2, $3, $4, $5, 'error', $6, 'outbox')`,
          [row.worker_id, row.job_posting_id, `system:outbox:${row.id}`, to, row.template_slug, result.error],
        ).catch((err: unknown) => {
          const error = err instanceof Error ? err : new Error(String(err));
          logger.warn({ error: error.message, outboxId: row.id }, 'Falha ao gravar log outbox erro');
          reportError(error, { source: 'OutboxProcessor:logFailed', outboxId: row.id });
        });
      }
      return;
    }

    const { externalId } = result.getValue()!;
    await this.db.query(
      `UPDATE messaging_outbox
       SET status = 'sent',
           attempts = $1,
           processed_at = NOW(),
           error = NULL,
           twilio_sid = $2,
           channel = $4
       WHERE id = $3`,
      [row.attempts + 1, externalId, row.id, channel],
    );

    // Log successful dispatch in audit table — best-effort
    await this.db.query(
      `INSERT INTO whatsapp_bulk_dispatch_logs
         (worker_id, job_posting_id, triggered_by, phone, template_slug, status, twilio_sid, source)
       VALUES ($1, $2, $3, $4, $5, 'sent', $6, 'outbox')`,
      [row.worker_id, row.job_posting_id, `system:outbox:${row.id}`, to, row.template_slug, externalId],
    ).catch((err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.warn({ error: error.message, outboxId: row.id }, 'Falha ao gravar log outbox sucesso');
      reportError(error, { source: 'OutboxProcessor:logSent', outboxId: row.id });
    });

    // D200.9: o convite AUTOMÁTICO também é um envio — carimba messaged_at na candidatura,
    // como o manual faz (MessagingController). Sem isto o card dizia "Sin envíos" depois do
    // auto-invite, com o "Reenviar" travado pela janela (que lê o log acima). Best-effort.
    // Os dois eventos abaixo são lidos pelo monitor diário (e2e-prod/smoke/outbox-messaged-at.smoke.ts):
    // `failed` > 0 nas últimas 24 h acende o alerta; `updated` é a evidência de que o serviço rodou.
    if (row.job_posting_id) {
      await this.db.query(
        `UPDATE worker_job_applications
         SET messaged_at = NOW(), updated_at = NOW()
         WHERE worker_id = $1 AND job_posting_id = $2`,
        [row.worker_id, row.job_posting_id],
      ).then(() => {
        logger.info({ outboxId: row.id, workerId: row.worker_id, jobPostingId: row.job_posting_id }, 'outbox.messaged_at.updated');
      }).catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.warn({ error: error.message, outboxId: row.id, workerId: row.worker_id, jobPostingId: row.job_posting_id }, 'outbox.messaged_at.failed');
        reportError(error, { source: 'OutboxProcessor:messagedAt', outboxId: row.id });
      });
    }
  }

  private async markFailed(id: string, attempts: number, error: string): Promise<void> {
    await this.db.query(
      `UPDATE messaging_outbox
       SET status = 'failed',
           attempts = $1,
           error = $2,
           processed_at = NOW()
       WHERE id = $3`,
      [attempts + 1, error, id],
    );
  }

  /**
   * Guardrail de pacing (parte b/c do parecer do Architect): teto diário de
   * envios via Periskope. env PERISKOPE_DAILY_CAP ausente ou 0/inválido =
   * sem teto (comportamento hoje, feature opt-in). Quando setado, consulta
   * quantas mensagens já foram enviadas HOJE por este canal — usa a coluna
   * messaging_outbox.channel (não workers.messaging_channel) porque o canal
   * do worker é mutável; o histórico do dia precisa refletir o canal
   * efetivamente usado em cada envio passado, não o canal atual do worker.
   */
  private async isPeriskopeDailyCapReached(): Promise<boolean> {
    const capRaw = parseInt(process.env.PERISKOPE_DAILY_CAP ?? '', 10);
    const cap = Number.isFinite(capRaw) && capRaw > 0 ? capRaw : 0;
    if (cap === 0) return false;

    const result = await this.db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM messaging_outbox
       WHERE status = 'sent'
         AND channel = 'periskope'
         AND processed_at::date = CURRENT_DATE`,
    );
    const count = parseInt(result.rows[0]?.count ?? '0', 10);
    return count >= cap;
  }
}
