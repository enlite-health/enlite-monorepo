/**
 * PendingProfileChangeRepository
 *
 * Acesso à tabela worker_pending_profile_changes — staging do fluxo propose/confirm
 * de updates de perfil pela Luz. O payload (campos validados) é guardado já
 * criptografado pelo use case; este repo só persiste/lê os bytes.
 */

import { Pool } from 'pg';

export interface PendingProfileChangeRecord {
  id: string;
  workerId: string;
  conversationRef: string | null;
  payloadEncrypted: string;
  fieldNames: string[];
  status: 'pending' | 'consumed' | 'expired';
  createdAt: Date;
  expiresAt: Date;
}

export interface InsertPendingChangeParams {
  workerId: string;
  conversationRef: string | null;
  payloadEncrypted: string;
  fieldNames: string[];
  ttlSeconds: number;
}

export class PendingProfileChangeRepository {
  constructor(private readonly pool: Pool) {}

  async insert(
    params: InsertPendingChangeParams,
  ): Promise<{ id: string; expiresAt: Date }> {
    const res = await this.pool.query<{ id: string; expires_at: Date }>(
      `INSERT INTO worker_pending_profile_changes
         (worker_id, conversation_ref, payload_encrypted, field_names, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + ($5 || ' seconds')::interval)
       RETURNING id, expires_at`,
      [
        params.workerId,
        params.conversationRef,
        params.payloadEncrypted,
        params.fieldNames,
        String(params.ttlSeconds),
      ],
    );
    return { id: res.rows[0].id, expiresAt: res.rows[0].expires_at };
  }

  /**
   * Carrega a mudança pendente, não expirada, deste worker.
   * Se `handle` for informado, precisa casar com o id (desambigua múltiplas).
   * Sem handle, devolve a mais recente.
   */
  async findActive(
    workerId: string,
    handle?: string,
  ): Promise<PendingProfileChangeRecord | null> {
    const conditions = ['worker_id = $1', `status = 'pending'`, 'expires_at > NOW()'];
    const values: unknown[] = [workerId];
    if (handle) {
      values.push(handle);
      conditions.push(`id = $${values.length}`);
    }
    const res = await this.pool.query<{
      id: string;
      worker_id: string;
      conversation_ref: string | null;
      payload_encrypted: string;
      field_names: string[];
      status: 'pending' | 'consumed' | 'expired';
      created_at: Date;
      expires_at: Date;
    }>(
      `SELECT id, worker_id, conversation_ref, payload_encrypted, field_names,
              status, created_at, expires_at
         FROM worker_pending_profile_changes
        WHERE ${conditions.join(' AND ')}
        ORDER BY created_at DESC
        LIMIT 1`,
      values,
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      workerId: r.worker_id,
      conversationRef: r.conversation_ref,
      payloadEncrypted: r.payload_encrypted,
      fieldNames: r.field_names,
      status: r.status,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
    };
  }

  /**
   * Marca como consumida de forma atômica (claim). Retorna true só se ainda
   * estava 'pending' — protege contra confirm duplicado / corrida.
   */
  async markConsumed(id: string): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE worker_pending_profile_changes
          SET status = 'consumed', consumed_at = NOW()
        WHERE id = $1 AND status = 'pending'`,
      [id],
    );
    return (res.rowCount ?? 0) > 0;
  }
}
