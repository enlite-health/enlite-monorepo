/**
 * txBoundPool — "pool" que NÃO pega conexão: tudo roda no `client` de uma transação que quem chama já segura
 * (spec 095 T-095-30, defeito de pool travado).
 *
 * Por que existe: o processador da inbox segura 1 conexão (lock + SAVEPOINT por linha) e, dentro dela, o caso de uso
 * de resposta chamava `pool.connect()`/`pool.query()` no MESMO pool. Em prd `DB_POOL_MAX=5` e `--concurrency=80`: 5
 * pushes simultâneos = 5 conexões presas esperando a 2ª, e o pool inteiro (todas as rotas da instância) para até o
 * `connectionTimeoutMillis`. Aqui o código de baixo continua escrevendo `pool.query(...)` / `pool.connect()` como
 * sempre, mas recebe este objeto, e a conexão é UMA só.
 *
 * Semântica preservada (o código de baixo foi escrito para pool em autocommit):
 *  - `query()`: cada comando roda num SAVEPOINT próprio. No pool, um comando que falha não deixa rastro e quem o
 *    chamou pode engolir o erro (best-effort); dentro de uma transação isso abortaria tudo ("current transaction is
 *    aborted"). Com o SAVEPOINT por comando, a falha desfaz só ele e o erro original é relançado.
 *  - `connect()`: devolve um client cujo `BEGIN`/`COMMIT`/`ROLLBACK` viram `SAVEPOINT`/`RELEASE`/`ROLLBACK TO`, e cujo
 *    `release()` não faz nada (a conexão é de quem chamou).
 *  - GUCs `SET LOCAL` (`app.current_uid`, `app.change_source`, `app.move_reason`): valem até o fim da transação
 *    EXTERNA, não do savepoint. O "COMMIT" aninhado os devolve ao valor de antes do "BEGIN", para o ator carimbado
 *    por uma etapa não vazar para as seguintes (nem para a linha seguinte da mesma chave).
 */
import type { Pool, PoolClient } from 'pg';

const LOCAL_GUCS = ['app.current_uid', 'app.change_source', 'app.move_reason'] as const;

type AnyArgs = Parameters<PoolClient['query']>;

function isControl(arg: unknown, word: 'BEGIN' | 'COMMIT' | 'ROLLBACK'): boolean {
  return typeof arg === 'string' && arg.trim().toUpperCase() === word;
}

export function txBoundPool(client: PoolClient): Pool {
  let seq = 0;
  const nextName = (): string => `txb_${(seq += 1)}`;
  const run = (...args: AnyArgs) => (client.query as (...a: unknown[]) => Promise<unknown>)(...(args as unknown[]));

  async function isolated(args: AnyArgs): Promise<unknown> {
    const sp = nextName();
    await client.query(`SAVEPOINT ${sp}`);
    try {
      const result = await run(...args);
      await client.query(`RELEASE SAVEPOINT ${sp}`);
      return result;
    } catch (err) {
      try {
        await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
        await client.query(`RELEASE SAVEPOINT ${sp}`);
      } catch {
        /* conexão perdida: o erro original é o que importa */
      }
      throw err;
    }
  }

  async function readGucs(): Promise<Array<string | null>> {
    const r = await client.query(
      `SELECT ${LOCAL_GUCS.map((g, i) => `current_setting('${g}', true) AS g${i}`).join(', ')}`,
    );
    return LOCAL_GUCS.map((_, i) => (r.rows[0]?.[`g${i}`] as string | null | undefined) ?? null);
  }

  async function restoreGucs(saved: Array<string | null>): Promise<void> {
    await client.query(
      `SELECT ${LOCAL_GUCS.map((g, i) => `set_config('${g}', $${i + 1}, true)`).join(', ')}`,
      saved.map((v) => v ?? ''),
    );
  }

  function boundClient(): PoolClient {
    const frames: Array<{ sp: string; saved: Array<string | null> }> = [];
    const query = async (...args: AnyArgs): Promise<unknown> => {
      if (isControl(args[0], 'BEGIN')) {
        const sp = nextName();
        await client.query(`SAVEPOINT ${sp}`);
        frames.push({ sp, saved: await readGucs() });
        return { rows: [], rowCount: null, command: 'BEGIN' };
      }
      if (isControl(args[0], 'COMMIT')) {
        const frame = frames.pop();
        if (frame) {
          await client.query(`RELEASE SAVEPOINT ${frame.sp}`);
          await restoreGucs(frame.saved);
        }
        return { rows: [], rowCount: null, command: 'COMMIT' };
      }
      if (isControl(args[0], 'ROLLBACK')) {
        const frame = frames.pop();
        if (frame) {
          await client.query(`ROLLBACK TO SAVEPOINT ${frame.sp}`);
          await client.query(`RELEASE SAVEPOINT ${frame.sp}`);
        }
        return { rows: [], rowCount: null, command: 'ROLLBACK' };
      }
      return run(...args);
    };
    return { query, release: () => undefined } as unknown as PoolClient;
  }

  return {
    query: (...args: AnyArgs) => isolated(args),
    connect: async () => boundClient(),
  } as unknown as Pool;
}
