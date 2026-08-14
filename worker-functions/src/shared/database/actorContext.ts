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
import { currentDbContext } from './requestDbSession';

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
 * Carimba o contexto de PAÍS na transação (ABAC Fase 1, task 3.1).
 *
 * `SET LOCAL` (`set_config(..., true)`) porque o client da transação vem do pool
 * cru — não é o client fixado da request, então ele chega sem contexto e não
 * pode levar contexto embora ao ser devolvido.
 *
 * A IDENTIDADE da conexão vem do `connect()` do pool recebido: quem passa o pool
 * de `getPool()` (todos os call sites de produção) recebe, sob contexto
 * `system`/`public`, um client do pool de sistema — sem isso a transação sairia
 * como `app_runtime` e o `app.system_context` não valeria nada. Ver
 * `rlsAwarePool.ts`.
 *
 * Sem contexto declarado (job legado ainda não classificado) a transação roda
 * como sempre: sob RLS isso é fail-closed (zero linhas), nunca permissivo.
 */
async function applyCountryContext(client: PoolClient): Promise<void> {
  const ctx = currentDbContext();
  if (!ctx) return;
  await client.query(
    `SELECT set_config('app.user_uid', $1, true),
            set_config('app.user_country', $2, true),
            set_config('app.system_context', $3, true)`,
    [ctx.uid ?? '', ctx.country ?? '', ctx.systemContext ?? ''],
  );
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
    await applyCountryContext(client);
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
