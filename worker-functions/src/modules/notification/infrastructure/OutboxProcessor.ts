import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { IMessagingService } from '../domain/IMessagingService';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { TokenService } from './TokenService';
import { loggingAls, logger, reportError } from '@shared/logging';

const MAX_ATTEMPTS = 3;
const BATCH_SIZE = 50;

interface OutboxRow {
  id: string;
  worker_id: string;
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
    const result = await this.db.query<OutboxRow>(
      `SELECT id, worker_id, template_slug, variables, attempts, trace_id
       FROM messaging_outbox
       WHERE id = $1 AND status = 'pending' AND attempts < $2
       LIMIT 1`,
      [outboxId, MAX_ATTEMPTS],
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
    const rows = await this.fetchPending();
    if (rows.length === 0) return;

    for (const row of rows) {
      await loggingAls.run(
        { traceId: row.trace_id ?? uuidv4(), workerId: row.worker_id },
        () => this.processOne(row),
      );
    }
  }

  private async fetchPending(): Promise<OutboxRow[]> {
    const result = await this.db.query<OutboxRow>(
      `SELECT id, worker_id, template_slug, variables, attempts, trace_id
       FROM messaging_outbox
       WHERE status = 'pending' AND attempts < $1
       ORDER BY created_at
       LIMIT $2`,
      [MAX_ATTEMPTS, BATCH_SIZE],
    );
    return result.rows;
  }

  private async processOne(row: OutboxRow): Promise<void> {
    // Busca telefone do worker (prefere whatsapp_phone_encrypted, fallback para phone)
    const workerResult = await this.db.query<{ whatsapp_phone_encrypted: string | null; phone: string | null }>(
      `SELECT whatsapp_phone_encrypted, phone FROM workers WHERE id = $1 LIMIT 1`,
      [row.worker_id],
    );

    if (workerResult.rows.length === 0) {
      await this.markFailed(row.id, row.attempts, 'Worker não encontrado');
      return;
    }

    const { whatsapp_phone_encrypted, phone } = workerResult.rows[0];
    const whatsappPhone = whatsapp_phone_encrypted
      ? await this.encryptionService.decrypt(whatsapp_phone_encrypted)
      : null;
    const to = whatsappPhone || phone;

    if (!to) {
      await this.markFailed(row.id, row.attempts, 'Worker sem telefone cadastrado');
      return;
    }

    // Resolve tokens PII (tk_*) para valores reais antes do envio
    const resolvedVariables = await this.tokenService.resolveVariables(row.variables ?? {});

    const result = await this.messaging.sendWhatsApp({
      to,
      templateSlug: row.template_slug,
      variables: resolvedVariables,
    });

    if (result.isFailure) {
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
             (worker_id, triggered_by, phone, template_slug, status, error_message, source)
           VALUES ($1, $2, $3, $4, 'error', $5, 'outbox')`,
          [row.worker_id, `system:outbox:${row.id}`, to, row.template_slug, result.error],
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
           twilio_sid = $2
       WHERE id = $3`,
      [row.attempts + 1, externalId, row.id],
    );

    // Log successful dispatch in audit table — best-effort
    await this.db.query(
      `INSERT INTO whatsapp_bulk_dispatch_logs
         (worker_id, triggered_by, phone, template_slug, status, twilio_sid, source)
       VALUES ($1, $2, $3, $4, 'sent', $5, 'outbox')`,
      [row.worker_id, `system:outbox:${row.id}`, to, row.template_slug, externalId],
    ).catch((err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.warn({ error: error.message, outboxId: row.id }, 'Falha ao gravar log outbox sucesso');
      reportError(error, { source: 'OutboxProcessor:logSent', outboxId: row.id });
    });
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
}
