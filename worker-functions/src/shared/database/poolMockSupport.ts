/**
 * src/shared/database/poolMockSupport.ts
 *
 * Suporte a TESTE (não é usado em produção) — mesma convenção de
 * `application/testFixtures/`.
 *
 * Depois que as escritas de funil passaram a rodar em transação
 * (`withActorContext`), um mock de pool que só tem `query` deixa de servir: o
 * código chama `pool.connect()` e executa no client.
 *
 * O client devolvido aqui:
 *   - RESPONDE SOZINHO ao `BEGIN` / `COMMIT` / `ROLLBACK` / `set_config`, sem
 *     tocar no mock. É o que preserva as suítes que enfileiram respostas com
 *     `mockResolvedValueOnce` na ordem das queries de negócio — as queries de
 *     controle da transação não consomem a fila nem entram nas asserções.
 *   - DELEGA todo o resto para a mesma função `query` do pool, então as
 *     asserções existentes continuam valendo sem mudança.
 *
 * Consequência aceita: o carimbo de ator em si (`set_config`) não é observável
 * por unit test com este mock. Ele é provado onde só o banco real pode provar —
 * `tests/e2e/rastreabilidade-ator.e2e.test.ts`, que afirma a linha gravada pelo
 * trigger.
 */

type QueryFn = (...args: any[]) => unknown; // eslint-disable-line @typescript-eslint/no-explicit-any

const TRANSACTION_CONTROL = /^\s*(BEGIN|COMMIT|ROLLBACK)\s*$|set_config\s*\(/i;

export interface PoolMockWithConnect<T extends QueryFn> {
  query: T;
  connect: () => Promise<{ query: QueryFn; release: () => void }>;
}

/** Envolve a `query` mockada num pool que também sabe `connect()`. */
export function poolMockWithConnect<T extends QueryFn>(query: T): PoolMockWithConnect<T> {
  const clientQuery: QueryFn = (sql: unknown, ...rest: unknown[]) => {
    if (typeof sql === 'string' && TRANSACTION_CONTROL.test(sql)) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    return query(sql, ...rest);
  };

  return {
    query,
    connect: async () => ({ query: clientQuery, release: () => undefined }),
  };
}
