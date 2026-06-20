/**
 * JobPostingAuditRepository
 *
 * Casca fina sobre BaseAuditLogRepository configurada para a tabela
 * job_posting_audit_log com FK job_posting_id.
 *
 * Usa composição (não herança) porque os métodos públicos têm assinatura
 * diferente da base (jobPostingId vs entityId) — herança viola contravariância
 * de parâmetros no TypeScript strict.
 *
 * API pública IDÊNTICA à versão anterior — nenhum caller precisa mudar:
 *   logEvent(client, params)          → params.jobPostingId
 *   logEventSafe(client, params)      → params.jobPostingId
 *   logFieldChanges(client, params)   → params.jobPostingId + params.fields (FieldChange[])
 *   logFieldChangesSafe(client, params)
 *
 * Tipos re-exportados (os callers importam daqui):
 *   AuditEventType, AuditActorType, AuditChangesPayload,
 *   LogEventParams, FieldChange, LogFieldChangesParams
 */

import type { PoolClient } from 'pg';
import { BaseAuditLogRepository } from '@shared/audit/BaseAuditLogRepository';

// ─── Re-exports de tipos compartilhados ──────────────────────────────────────
// Callers importam esses símbolos diretamente deste arquivo — manter os paths.

export type {
  AuditEventType,
  AuditActorType,
  AuditChangesPayload,
} from '@shared/audit/types';

// ─── Tipos da API pública específicos de vagas ────────────────────────────────

/** Parâmetros de logEvent com `jobPostingId` (API pública preservada). */
export interface LogEventParams {
  jobPostingId: string;
  eventType: import('@shared/audit/types').AuditEventType;
  /** Nome do campo alterado — obrigatório para UPDATED/STATUS_CHANGED/DRAFT_CHANGED. */
  fieldName?: string | null;
  /** Diff do campo: { before, after }. Para CREATED: { before: null, after: snapshot }. */
  changes: import('@shared/audit/types').AuditChangesPayload;
  /** firebase_uid do usuário autenticado. Null para atores automatizados. */
  actorUserId?: string | null;
  actorType: import('@shared/audit/types').AuditActorType;
  /** Label livre do componente ator (ex: "clickup-sync"). */
  actorLabel?: string | null;
  /** Correlaciona com Cloud Logging via jsonPayload.traceId. */
  traceId?: string | null;
}

/** Campo alterado individualmente (API pública preservada). */
export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

/** Parâmetros de logFieldChanges com `jobPostingId` (API pública preservada). */
export interface LogFieldChangesParams {
  jobPostingId: string;
  fields: FieldChange[];
  actorUserId?: string | null;
  actorType: import('@shared/audit/types').AuditActorType;
  actorLabel?: string | null;
  traceId?: string | null;
}

// ─── Repositório (composição) ─────────────────────────────────────────────────

/** Instância interna compartilhada por todos os métodos desta casca. */
const BASE = new BaseAuditLogRepository({
  tableName: 'job_posting_audit_log',
  entityColumn: 'job_posting_id',
});

export class JobPostingAuditRepository {
  // ── logEvent ────────────────────────────────────────────────────────────────

  /**
   * Registra um único evento de auditoria dentro de uma transação existente.
   * Adapta `jobPostingId` → `entityId` ao chamar a base.
   *
   * @param client - PoolClient da transação aberta pelo caller
   * @param params - Dados do evento
   */
  async logEvent(client: PoolClient, params: LogEventParams): Promise<void> {
    return BASE.logEvent(client, {
      entityId: params.jobPostingId,
      eventType: params.eventType,
      fieldName: params.fieldName,
      changes: params.changes,
      actorUserId: params.actorUserId,
      actorType: params.actorType,
      actorLabel: params.actorLabel,
      traceId: params.traceId,
    });
  }

  // ── logEventSafe ────────────────────────────────────────────────────────────

  /**
   * Best-effort variant de logEvent.
   * SAVEPOINT absorve falhas de FK sem abortar a transação envolvente.
   */
  async logEventSafe(client: PoolClient, params: LogEventParams): Promise<void> {
    return BASE.logEventSafe(client, {
      entityId: params.jobPostingId,
      eventType: params.eventType,
      fieldName: params.fieldName,
      changes: params.changes,
      actorUserId: params.actorUserId,
      actorType: params.actorType,
      actorLabel: params.actorLabel,
      traceId: params.traceId,
    });
  }

  // ── logFieldChanges ─────────────────────────────────────────────────────────

  /**
   * Registra N alterações de campos em batch (uma linha por campo).
   * Campos sem mudança real devem ser pré-filtrados via captureVacancyDiff.
   */
  async logFieldChanges(
    client: PoolClient,
    params: LogFieldChangesParams,
  ): Promise<void> {
    return BASE.logFieldChanges(client, {
      entityId: params.jobPostingId,
      fields: params.fields,
      actorUserId: params.actorUserId,
      actorType: params.actorType,
      actorLabel: params.actorLabel,
      traceId: params.traceId,
    });
  }

  // ── logFieldChangesSafe ─────────────────────────────────────────────────────

  /**
   * Best-effort variant de logFieldChanges.
   * Cada campo em seu próprio SAVEPOINT — falha individual não aborta os demais.
   */
  async logFieldChangesSafe(
    client: PoolClient,
    params: LogFieldChangesParams,
  ): Promise<void> {
    return BASE.logFieldChangesSafe(client, {
      entityId: params.jobPostingId,
      fields: params.fields,
      actorUserId: params.actorUserId,
      actorType: params.actorType,
      actorLabel: params.actorLabel,
      traceId: params.traceId,
    });
  }
}
