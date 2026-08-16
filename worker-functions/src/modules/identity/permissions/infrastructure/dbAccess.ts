/**
 * src/modules/identity/permissions/infrastructure/dbAccess.ts
 *
 * As DUAS formas de escrever em `iam.*` — e o porquê de serem duas.
 *
 * 1. `withStaffWrite`: ato de GESTOR (criar grupo, conceder país, colocar
 *    membro). Roda em `withActorContext`, que carimba `app.user_uid` a partir do
 *    contexto da request; as funções da mig 279 leem o ATOR desse GUC, nunca de
 *    parâmetro — quem chama não escolhe quem foi. Sem contexto (script, job) o
 *    GUC sai vazio e a função recusa com 42501: fail-closed de graça.
 *
 * 2. `withSystemWrite`: ato de BOOT (sync do catálogo, sync do manifest de
 *    features). Não tem gestor por trás, então o gate é outro: ACL (só
 *    `app_system` tem EXECUTE) + `app.system_context` declarado. Abre o client
 *    no pool de SISTEMA e declara o rótulo explicitamente em vez de depender de
 *    `withSystemDbContext` — porque aquele caminho só aplica GUC com
 *    `COUNTRY_RLS_ENABLED=true`, e o sync do boot precisa funcionar igual dos
 *    dois lados da virada.
 */

import type { Pool, PoolClient } from 'pg';
import { withActorContext } from '@shared/database/actorContext';
import { toPermissionError } from '../domain/PermissionError';

/** Escrita de gestor: ator vem do contexto da request (GUC `app.user_uid`). */
export async function withStaffWrite<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  try {
    return await withActorContext(pool, fn);
  } catch (err) {
    throw toPermissionError(err);
  }
}

/** Escrita de boot: pool de sistema + `app.system_context` declarado. */
export async function withSystemWrite<T>(
  systemPool: Pool,
  label: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await systemPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.system_context', $1, true)`, [label]);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      /* conexão perdida — rollback implícito */
    });
    throw toPermissionError(err);
  } finally {
    client.release();
  }
}

/** Leitura: erro de banco também vira vocabulário do módulo (42501 → forbidden). */
export async function readRows<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toPermissionError(err);
  }
}
