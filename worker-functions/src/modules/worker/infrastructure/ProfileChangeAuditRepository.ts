/**
 * ProfileChangeAuditRepository
 *
 * Grava o audit de updates de perfil aplicados via propose/confirm da Luz na
 * tabela worker_profile_changes_audit. Valores já chegam REDIGIDOS (ver
 * profileChangeRedaction) — este repo nunca recebe PII em claro.
 */

import { Pool, PoolClient } from 'pg';

export interface ProfileChangeAuditEntry {
  workerId: string;
  pendingChangeId: string | null;
  fieldName: string;
  oldValueRedacted: string | null;
  newValueRedacted: string | null;
  changedBy: string;
  source: string;
  conversationRef: string | null;
}

export class ProfileChangeAuditRepository {
  /** Aceita PoolClient pra gravar dentro da transação da edição (mesma atomicidade). */
  constructor(private readonly pool: Pool | PoolClient) {}

  async recordBatch(entries: ProfileChangeAuditEntry[]): Promise<void> {
    if (entries.length === 0) return;

    const cols = 8;
    const placeholders: string[] = [];
    const values: unknown[] = [];
    entries.forEach((e, i) => {
      const base = i * cols;
      placeholders.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`,
      );
      values.push(
        e.workerId,
        e.pendingChangeId,
        e.fieldName,
        e.oldValueRedacted,
        e.newValueRedacted,
        e.changedBy,
        e.source,
        e.conversationRef,
      );
    });

    await this.pool.query(
      `INSERT INTO worker_profile_changes_audit
         (worker_id, pending_change_id, field_name, old_value_redacted,
          new_value_redacted, changed_by, source, conversation_ref)
       VALUES ${placeholders.join(', ')}`,
      values,
    );
  }
}
