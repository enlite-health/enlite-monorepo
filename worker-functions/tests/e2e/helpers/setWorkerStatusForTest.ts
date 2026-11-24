/**
 * setWorkerStatusForTest — fixture de teste que muda `workers.status` DECLARANDO o fluxo (spec 093, T012).
 *
 * A migration 591 recusa todo UPDATE que muda `workers.status` sem `app.status_flow` na MESMA transação.
 * Este helper abre BEGIN, carimba `TEST_FIXTURE` (set_config LOCAL) e só então faz o UPDATE — o rastro vai
 * para `worker_status_history.flow = 'TEST_FIXTURE'`. Os demais triggers (ex.: `trg_guard_registered_status`)
 * continuam valendo: se o UPDATE falhar, a transação faz ROLLBACK e o erro ORIGINAL sobe (nunca o de "sem fluxo").
 *
 * Aceita Pool (abre e libera um client próprio) ou PoolClient já fora de transação.
 */
import type { Pool, PoolClient } from 'pg';

type Db = Pool | PoolClient;

const isPool = (db: Db): db is Pool => typeof (db as Pool).connect === 'function' && !('release' in db);

export async function setWorkerStatusForTest(db: Db, workerId: string, status: string): Promise<void> {
  const client = isPool(db) ? await db.connect() : db;
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.status_flow', 'TEST_FIXTURE', true)`);
    await client.query('UPDATE workers SET status = $2 WHERE id = $1', [workerId, status]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    if (isPool(db)) (client as PoolClient).release();
  }
}
