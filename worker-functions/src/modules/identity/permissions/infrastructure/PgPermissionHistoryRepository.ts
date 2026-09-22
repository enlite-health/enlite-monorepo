/**
 * src/modules/identity/permissions/infrastructure/PgPermissionHistoryRepository.ts
 *
 * Histórico de mudanças de permissão (substitui a Auditoría ALLOW/DENY na UI).
 * Leitura gated em `iam.query_permission_history` (mig 458, molde de
 * `PgPermissionAuditRepository`/`iam.query_audit`): transação com o ator no
 * GUC (`withStaffWrite`/`withActorContext`), nunca `pool.connect()` cru — sem
 * o ator carimbado a função SECURITY DEFINER recusa com 42501.
 */

import type { Pool } from 'pg';
import type { PermissionHistoryFilters, PermissionHistoryRepository } from '../application/ports';
import type { PermissionHistoryEvent, PermissionHistoryEventType, PermissionHistoryOp } from '../domain/PermissionHistory';
import { readRows, withStaffWrite } from './dbAccess';

interface HistoryRow {
  event_type: PermissionHistoryEventType;
  occurred_at: Date;
  group_id: string;
  group_name: string;
  actor_uid: string | null;
  actor_display_name: string | null;
  actor_email: string | null;
  op: PermissionHistoryOp;
  resource: string | null;
  action: string | null;
  subject_user_id: string | null;
  subject_display_name: string | null;
  subject_email: string | null;
}

function toEvent(row: HistoryRow): PermissionHistoryEvent {
  return {
    eventType: row.event_type,
    occurredAt: row.occurred_at,
    groupId: row.group_id,
    groupName: row.group_name,
    actorUid: row.actor_uid,
    actorDisplayName: row.actor_display_name,
    actorEmail: row.actor_email,
    op: row.op,
    resource: row.resource,
    action: row.action,
    subjectUserId: row.subject_user_id,
    subjectDisplayName: row.subject_display_name,
    subjectEmail: row.subject_email,
  };
}

export class PgPermissionHistoryRepository implements PermissionHistoryRepository {
  constructor(private readonly pool: Pool) {}

  async query(filters: PermissionHistoryFilters): Promise<PermissionHistoryEvent[]> {
    // Transação (não `pool.query` solto): a função lê o ator do GUC, que
    // `withStaffWrite`/`withActorContext` carimba na sessão — mesmo molde do
    // `PgPermissionAuditRepository.query`, apesar do nome "Write" (é sobre o
    // contexto da transação, não sobre gravar).
    return withStaffWrite(this.pool, async (client) => {
      const result = await readRows(() =>
        client.query<HistoryRow>(`SELECT * FROM iam.query_permission_history($1, $2, $3)`, [
          filters.groupId ?? null,
          filters.type ?? null,
          filters.limit ?? null,
        ]),
      );
      return result.rows.map(toEvent);
    });
  }
}
