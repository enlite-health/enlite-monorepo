/**
 * src/shared/database/rlsAwarePool.ts
 *
 * O pool que `DatabaseConnection.getPool()` entrega: idêntico ao `Pool` do `pg`
 * em tudo, menos numa coisa — `query()` roteia para o client FIXADO da request
 * (com `app.user_country`/`app.user_uid`/`app.system_context` já aplicados)
 * quando existe contexto declarado e `COUNTRY_RLS_ENABLED=true`.
 *
 * É um `Proxy` sobre o pool real de propósito: os 115 pontos que fazem
 * `DatabaseConnection.getInstance().getPool()` continuam recebendo algo que
 * passa em `instanceof Pool`, expõe `totalCount`, `on('error')`, `end()` etc.
 * Nenhum dos 353 call sites de `.query()` muda de linha.
 *
 * `connect()` NÃO é desviado: quem pede um client quer transação própria
 * (`withActorContext`), e lá o contexto entra como `SET LOCAL` na transação.
 *
 * Com a flag desligada isto é passagem direta — o custo é uma chamada de função.
 */

import type { Pool, PoolClient, QueryResult } from 'pg';
import { logger } from '@shared/logging';
import {
  acquireSessionClient,
  currentDbSession,
  isCountryRlsEnabled,
  type DbSession,
} from './requestDbSession';

type QueryArgs = Parameters<Pool['query']>;

/**
 * Envolve o pool. Idempotente na prática: chamar duas vezes só cria dois
 * proxies sobre o mesmo alvo.
 */
export function createRlsAwarePool(pool: Pool): Pool {
  return new Proxy(pool, {
    get(target, prop, receiver) {
      if (prop === 'query') {
        return (...args: QueryArgs): Promise<QueryResult> => rlsAwareQuery(target, args);
      }
      const value = Reflect.get(target, prop, receiver);
      // Métodos vão ligados ao pool REAL: sem isso, `query` interno do pg
      // voltaria pelo proxy e entraria em recursão.
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function rlsAwareQuery(pool: Pool, args: QueryArgs): Promise<QueryResult> {
  const session = currentDbSession();

  // Sem contexto declarado (job legado, teste, flag off) → pool cru, como sempre.
  // Sob RLS isso é fail-closed: a policy não acha país nenhum e devolve 0 linhas.
  if (!session || !session.context || session.released || !isCountryRlsEnabled()) {
    warnIfUnclassified(session);
    return (pool.query as (...a: QueryArgs) => Promise<QueryResult>)(...args);
  }

  return runOnSessionClient(pool, session, args);
}

/**
 * Request que consulta o banco sem classificação nenhuma — é exatamente a lista
 * que o MODO RELATÓRIO (task 4.2) precisa antes da virada: cada linha destas é
 * uma tela ou job que apagaria sob RLS. Um aviso por request, não por query.
 */
function warnIfUnclassified(session: DbSession | undefined): void {
  if (!session || session.context || session.released || session.warnedUnclassified) return;
  session.warnedUnclassified = true;
  logger.warn(
    {},
    '[abac] request consultou o banco sem contexto declarado — sob RLS devolveria zero linhas',
  );
}

function runOnSessionClient(pool: Pool, session: DbSession, args: QueryArgs): Promise<QueryResult> {
  return acquireSessionClient(pool, session).then((client: PoolClient) =>
    (client.query as (...a: QueryArgs) => Promise<QueryResult>)(...args),
  ) as Promise<QueryResult>;
}
