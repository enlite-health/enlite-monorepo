/**
 * src/shared/audit/types.ts
 *
 * Tipos canônicos compartilhados entre BaseAuditLogRepository e todas as
 * implementações concretas (JobPostingAuditRepository, futuros WorkerAuditRepository…).
 *
 * Mantidos separados para que callers possam importar APENAS os tipos sem
 * instanciar o repositório.
 */

// ─── Enums de domínio ─────────────────────────────────────────────────────────

export type AuditEventType =
  | 'CREATED'
  | 'UPDATED'
  | 'DELETED'
  | 'STATUS_CHANGED'
  | 'DRAFT_CHANGED';

export type AuditActorType = 'HUMAN' | 'SYSTEM' | 'WEBHOOK' | 'CLI';

// ─── Payload de diff ──────────────────────────────────────────────────────────

export interface AuditChangesPayload {
  before: unknown;
  after: unknown;
}

// ─── Diff de campo (versão genérica) ──────────────────────────────────────────

/** Diff de um campo individual retornado por captureEntityDiff. */
export interface EntityFieldDiff {
  field: string;
  before: unknown;
  after: unknown;
}

// ─── Params genéricos para logEvent ──────────────────────────────────────────

/**
 * Params usados pela BaseAuditLogRepository.
 * O campo `entityId` é genérico — cada casca concreta o mapeia para o nome
 * semântico da entidade (ex: `jobPostingId`).
 */
export interface BaseLogEventParams {
  entityId: string;
  eventType: AuditEventType;
  /** Nome do campo alterado — obrigatório para UPDATED/STATUS_CHANGED/DRAFT_CHANGED. */
  fieldName?: string | null;
  /** Diff do campo: { before, after }. Para CREATED: { before: null, after: snapshot }. */
  changes: AuditChangesPayload;
  /** firebase_uid do usuário autenticado. Null para atores automatizados. */
  actorUserId?: string | null;
  actorType: AuditActorType;
  /** Label livre do componente ator (ex: "clickup-sync"). */
  actorLabel?: string | null;
  /** Correlaciona com Cloud Logging via jsonPayload.traceId. */
  traceId?: string | null;
}

// ─── Params genéricos para logFieldChanges ────────────────────────────────────

export interface BaseLogFieldChangesParams {
  entityId: string;
  fields: EntityFieldDiff[];
  actorUserId?: string | null;
  actorType: AuditActorType;
  actorLabel?: string | null;
  traceId?: string | null;
}

// ─── Config da tabela ─────────────────────────────────────────────────────────

/** Configuração que cada repositório concreto passa ao construtor da base. */
export interface AuditTableConfig {
  /** Nome da tabela de audit. Ex: 'job_posting_audit_log'. */
  tableName: string;
  /** Nome da coluna FK para a entidade. Ex: 'job_posting_id'. */
  entityColumn: string;
}
