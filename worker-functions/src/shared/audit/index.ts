/**
 * src/shared/audit/index.ts
 *
 * Barrel export do módulo shared/audit.
 *
 * Para auditar uma nova entidade:
 *   1. Copie worker-functions/migrations/_TEMPLATE_audit_log.sql.example,
 *      substitua os placeholders e numere como migration real.
 *   2. Crie <Entity>AuditRepository estendendo BaseAuditLogRepository com
 *      { tableName: '<entity>_audit_log', entityColumn: '<entity>_id' }.
 *   3. Use captureEntityDiff para calcular o diff antes de chamar logFieldChanges.
 */

export { BaseAuditLogRepository, resolveEventType } from './BaseAuditLogRepository';
export { captureEntityDiff } from './captureEntityDiff';
export type {
  AuditEventType,
  AuditActorType,
  AuditChangesPayload,
  EntityFieldDiff,
  BaseLogEventParams,
  BaseLogFieldChangesParams,
  AuditTableConfig,
} from './types';
