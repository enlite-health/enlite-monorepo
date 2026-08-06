/**
 * src/shared/database/actorContext.ts
 *
 * Roda escritas dentro de uma transação que carimba QUEM está escrevendo.
 *
 * Os triggers `fn_log_worker_status_change` e `fn_log_application_stage_change`
 * gravam o histórico lendo o setting de sessão `app.current_uid` →
 * `worker_*_history.changed_by`.
 *
 * A identidade carrega a fonte no PREFIXO (`staff:`, `luz:`, `worker_self`,
 * `system:`, `sync:`) — de propósito: assim a medição não depende de alterar os
 * triggers em produção. `app.change_source` também é setado, para a coluna
 * `change_source` (hoje sempre NULL) ser aproveitável se um dia os triggers
 * passarem a lê-la; enquanto isso é inofensivo.
 *
 * `set_config(..., true)` é LOCAL À TRANSAÇÃO — por isso as queries precisam
 * rodar no mesmo client, e não em `pool.query` soltos. Esta função generaliza o
 * que `DeactivateWorkerAccountUseCase` e `UpdateWorkerProfileFieldsUseCase` já
 * faziam à mão.
 *
 * Sem ator (explícito ou no ALS) a transação roda igual, só sem carimbo — o
 * comportamento de hoje. Nunca falhar uma escrita por causa de auditoria.
 */

import type { Pool, PoolClient } from 'pg';
import { loggingAls } from '@shared/logging';
import type { ActorContext } from '@shared/audit/actorSource';

/**
 * Ator do contexto atual: o explícito ganha do que veio da request (ALS).
 *
 * `loggingAls?.` de propósito (mesmo padrão de WorkerAuditRepository): fora de
 * uma request — e em teste com `@shared/logging` mockado — o ALS pode nem
 * existir, e auditoria nunca pode derrubar a escrita.
 */
export function resolveActor(override?: ActorContext | null): ActorContext | null {
  return override ?? loggingAls?.getStore?.()?.actor ?? null;
}

/**
 * Abre transação, carimba o ator e roda `fn`. Commit no sucesso, rollback em
 * qualquer erro (o erro é repropagado — quem chama decide o que fazer).
 *
 * @param actor ator explícito; omitido, usa o da request (ALS).
 */
export async function withActorContext<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
  actor?: ActorContext | null,
): Promise<T> {
  const resolved = resolveActor(actor);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (resolved) {
      await client.query(`SELECT set_config('app.current_uid', $1, true)`, [resolved.id]);
      await client.query(`SELECT set_config('app.change_source', $1, true)`, [resolved.source]);
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* conexão já perdida — o rollback é implícito */
    }
    throw err;
  } finally {
    client.release();
  }
}
