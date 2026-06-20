/**
 * src/shared/audit/BaseAuditLogRepository.ts
 *
 * Repositório base genérico de audit log.
 *
 * Instanciar com { tableName, entityColumn } para qualquer entidade:
 *
 *   new BaseAuditLogRepository({
 *     tableName: 'job_posting_audit_log',
 *     entityColumn: 'job_posting_id',
 *   })
 *
 * A tabela-alvo deve seguir o schema canônico da ADR-007:
 *   (id, <entityColumn>, event_type, field_name, changes,
 *    actor_user_id, actor_type, actor_label, trace_id, created_at)
 *
 * Design: aceita PoolClient (transação externa) para que o caller insira
 * o audit DENTRO da mesma transação do UPDATE da entidade, garantindo
 * atomicidade. Os métodos *Safe usam SAVEPOINTs para que falhas de FK
 * no audit não abortem a transação principal.
 */

import type { PoolClient } from 'pg';
import { logger } from '@shared/logging';
import type {
  AuditTableConfig,
  AuditChangesPayload,
  AuditEventType,
  BaseLogEventParams,
  BaseLogFieldChangesParams,
} from './types';

// ─── Helper interno ───────────────────────────────────────────────────────────

/**
 * Mapeia o nome do campo para o event_type semântico correto.
 * Mantido aqui como SSOT — `JobPostingAuditRepository` não precisa reimplementar.
 */
export function resolveEventType(fieldName: string): AuditEventType {
  if (fieldName === 'status') return 'STATUS_CHANGED';
  if (fieldName === 'is_draft') return 'DRAFT_CHANGED';
  return 'UPDATED';
}

// ─── Repositório base ─────────────────────────────────────────────────────────

export class BaseAuditLogRepository {
  private readonly config: AuditTableConfig;
  private readonly insertSql: string;

  constructor(config: AuditTableConfig) {
    this.config = config;
    // Monta o INSERT dinamicamente a partir da config — evita hardcoding
    // do nome da tabela e da coluna FK em cada implementação concreta.
    this.insertSql = `
      INSERT INTO ${config.tableName}
        (${config.entityColumn}, event_type, field_name, changes,
         actor_user_id, actor_type, actor_label, trace_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `;
  }

  // ─── logEvent ──────────────────────────────────────────────────────────────

  /**
   * Registra um único evento de auditoria dentro de uma transação existente.
   *
   * @param client - PoolClient da transação aberta pelo caller
   * @param params - Dados do evento (usa `entityId` como chave genérica)
   */
  async logEvent(
    client: PoolClient,
    params: BaseLogEventParams,
  ): Promise<void> {
    const log = logger.child({
      [this.config.entityColumn]: params.entityId,
      eventType: params.eventType,
      table: this.config.tableName,
    });

    const values: unknown[] = [
      params.entityId,
      params.eventType,
      params.fieldName ?? null,
      JSON.stringify(params.changes),
      params.actorUserId ?? null,
      params.actorType,
      params.actorLabel ?? null,
      params.traceId ?? null,
    ];

    await client.query(this.insertSql, values);

    log.info({
      msg: `${this.config.tableName}: event logged`,
      fieldName: params.fieldName ?? null,
      actorType: params.actorType,
      actorLabel: params.actorLabel ?? null,
    });
  }

  // ─── logEventSafe ──────────────────────────────────────────────────────────

  /**
   * Best-effort variant de logEvent.
   * Usa um SAVEPOINT para que uma falha de INSERT de audit (ex: FK violation
   * em actor_user_id) NÃO aborte a transação envolvente. O COMMIT do caller
   * ainda terá sucesso.
   */
  async logEventSafe(
    client: PoolClient,
    params: BaseLogEventParams,
  ): Promise<void> {
    const sp = `audit_sp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    try {
      await client.query(`SAVEPOINT ${sp}`);
      await this.logEvent(client, params);
      await client.query(`RELEASE SAVEPOINT ${sp}`);
    } catch (err) {
      try { await client.query(`ROLLBACK TO SAVEPOINT ${sp}`); } catch { /* ignore */ }
      try { await client.query(`RELEASE SAVEPOINT ${sp}`); } catch { /* ignore */ }
      const e = err instanceof Error ? err : new Error(String(err));
      logger.error({
        msg: `${this.config.tableName}: logEventSafe swallowed error`,
        [this.config.entityColumn]: params.entityId,
        eventType: params.eventType,
        error: e.message,
      });
    }
  }

  // ─── logFieldChanges ───────────────────────────────────────────────────────

  /**
   * Registra N alterações de campos em batch (uma linha por campo).
   * Campos sem mudança real devem ser pré-filtrados via captureEntityDiff.
   *
   * @param client - PoolClient da transação aberta pelo caller
   * @param params - Lista de campos alterados e contexto do ator
   */
  async logFieldChanges(
    client: PoolClient,
    params: BaseLogFieldChangesParams,
  ): Promise<void> {
    if (params.fields.length === 0) return;

    const log = logger.child({
      [this.config.entityColumn]: params.entityId,
      fieldCount: params.fields.length,
      table: this.config.tableName,
    });

    for (const fc of params.fields) {
      const eventType: AuditEventType = resolveEventType(fc.field);

      const values: unknown[] = [
        params.entityId,
        eventType,
        fc.field,
        JSON.stringify({ before: fc.before, after: fc.after } satisfies AuditChangesPayload),
        params.actorUserId ?? null,
        params.actorType,
        params.actorLabel ?? null,
        params.traceId ?? null,
      ];

      await client.query(this.insertSql, values);
    }

    log.info({
      msg: `${this.config.tableName}: field changes logged`,
      fields: params.fields.map(f => f.field),
      actorType: params.actorType,
    });
  }

  // ─── logFieldChangesSafe ───────────────────────────────────────────────────

  /**
   * Best-effort variant de logFieldChanges.
   * Cada campo é envolvido em seu próprio SAVEPOINT para que uma falha
   * individual não aborte campos subsequentes nem a transação envolvente.
   */
  async logFieldChangesSafe(
    client: PoolClient,
    params: BaseLogFieldChangesParams,
  ): Promise<void> {
    if (params.fields.length === 0) return;
    for (const fc of params.fields) {
      await this.logEventSafe(client, {
        entityId: params.entityId,
        eventType: resolveEventType(fc.field),
        fieldName: fc.field,
        changes: { before: fc.before, after: fc.after },
        actorUserId: params.actorUserId,
        actorType: params.actorType,
        actorLabel: params.actorLabel,
        traceId: params.traceId,
      });
    }
  }
}
