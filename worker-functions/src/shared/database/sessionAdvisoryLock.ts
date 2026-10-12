import { AsyncLocalStorage } from 'async_hooks';
import type { Pool, PoolClient } from 'pg';

export type SessionLockResult<T> = { acquired: true; value: T } | { acquired: false };

interface HeldSession {
  db: Pool;
  holder: PoolClient;
  /** O unlock falhou: a conexão não devolveu o lock, então é descartada ao fim (o Postgres solta o lock ao fechá-la). */
  broken: boolean;
}

/** A sessão que o ENCADEAMENTO atual já segura (uma trava dentro de outra): a trava de dentro reusa a conexão da de fora. */
const held = new AsyncLocalStorage<HeldSession>();

/**
 * Exclusão mútua por chave: advisory lock de SESSÃO do Postgres (não de transação), `pg_try_advisory_lock`.
 *
 * A conexão que segura o lock fica ociosa: NENHUMA transação fica aberta enquanto `fn` fala com a rede. Quem chega com a
 * chave ocupada não espera: devolve `{ acquired: false }` e o chamador decide (pular, tentar na rodada seguinte). Vale entre
 * processos e instâncias (a trava é do banco). `fn` que lança solta a trava antes de propagar; se o unlock falhar, a conexão
 * é descartada. A chave nunca é logada nem entra em erro.
 *
 * Trava dentro de trava (a importação segura a da reunião e, dentro dela, a da responsável): a de dentro usa a MESMA conexão
 * da de fora (o Postgres aceita várias chaves na mesma sessão). Assim uma importação em voo custa 1 conexão de trava, não 2 —
 * o pool de sistema da stage/prd é pequeno (`DB_SYSTEM_POOL_MAX`, 5) e a trava dupla esgotaria o pool de uma 2ª importação.
 */
export async function withSessionAdvisoryLock<T>(db: Pool, key: string, fn: () => Promise<T>): Promise<SessionLockResult<T>> {
  const outer = held.getStore();
  const own: HeldSession | null = outer && outer.db === db ? null : { db, holder: await db.connect(), broken: false };
  const session = own ?? (outer as HeldSession);
  try {
    const got = await session.holder.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok`, [key]);
    if (!got.rows[0]?.ok) return { acquired: false };
    try {
      return { acquired: true, value: await (own ? held.run(own, fn) : fn()) };
    } finally {
      try {
        await session.holder.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [key]);
      } catch {
        session.broken = true;
      }
    }
  } finally {
    if (own) own.holder.release(own.broken);
  }
}
