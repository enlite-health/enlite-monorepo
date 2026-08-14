/**
 * src/shared/database/rlsAwarePool.ts
 *
 * O pool que `DatabaseConnection.getPool()` entrega: idêntico ao `Pool` do `pg`
 * em tudo, menos em duas coisas —
 *
 *  1. `query()` roteia para o client FIXADO da request (com
 *     `app.user_country`/`app.user_uid`/`app.system_context` já aplicados);
 *  2. `query()` e `connect()` escolhem de QUAL POOL esse client sai: contexto
 *     `staff`/`worker_self` → pool de runtime (`app_runtime`, confinado ao
 *     país); `system`/`public` → pool de sistema (`app_system`, o atalho
 *     declarado). Ver `dbPoolRoleFor` em `requestDbSession.ts`.
 *
 * Ambas só valem com contexto declarado e `COUNTRY_RLS_ENABLED=true`.
 *
 * É um `Proxy` sobre o pool real de propósito: os 115 pontos que fazem
 * `DatabaseConnection.getInstance().getPool()` continuam recebendo algo que
 * passa em `instanceof Pool`, expõe `totalCount`, `on('error')`, `end()` etc.
 * Nenhum dos 353 call sites de `.query()` muda de linha.
 *
 * `connect()` NÃO é desviado para o client fixado — quem pede um client quer
 * transação própria (`withActorContext`), e lá o contexto entra como `SET LOCAL`
 * na transação. Mas ele É roteado por identidade: uma escrita sob contexto de
 * sistema precisa sair da conexão de `app_system`, senão a policy do atalho não
 * se aplica e a transação enxerga só o país (ou nada).
 *
 * Com a flag desligada isto é passagem direta ao pool principal — o custo é uma
 * chamada de função, e o pool de sistema nunca é tocado.
 */

import type { Pool, PoolClient, QueryResult } from 'pg';
import { logger } from '@shared/logging';
import {
  acquireSessionClient,
  currentDbSession,
  dbPoolRoleFor,
  isCountryRlsEnabled,
  type DbSession,
} from './requestDbSession';

type QueryArgs = Parameters<Pool['query']>;

/**
 * Envolve o pool. `systemPool` omitido = o próprio pool (configuração de hoje,
 * sem `DB_SYSTEM_USER`/`DATABASE_SYSTEM_URL`): roteamento vira no-op.
 *
 * Idempotente na prática: chamar duas vezes só cria dois proxies sobre o mesmo alvo.
 */
export function createRlsAwarePool(pool: Pool, systemPool?: Pool): Pool {
  const system = systemPool ?? pool;

  return new Proxy(pool, {
    get(target, prop, receiver) {
      if (prop === 'query') {
        return (...args: QueryArgs): Promise<QueryResult> => rlsAwareQuery(target, system, args);
      }
      if (prop === 'connect') {
        return (...args: unknown[]): unknown =>
          (poolForCurrentContext(target, system).connect as (...a: unknown[]) => unknown)(...args);
      }
      const value = Reflect.get(target, prop, receiver);
      // Métodos vão ligados ao pool REAL: sem isso, `query` interno do pg
      // voltaria pelo proxy e entraria em recursão.
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Identidade de banco desta request. Sem flag, sem sessão, sem contexto ou com a
 * sessão já encerrada → pool principal, exatamente como antes da change.
 */
function poolForCurrentContext(pool: Pool, systemPool: Pool): Pool {
  const session = currentDbSession();
  if (!session || !session.context || session.released || !isCountryRlsEnabled()) return pool;
  return dbPoolRoleFor(session.context.kind) === 'system' ? systemPool : pool;
}

function rlsAwareQuery(pool: Pool, systemPool: Pool, args: QueryArgs): Promise<QueryResult> {
  const session = currentDbSession();

  // Sem contexto declarado (job legado, teste, flag off) → pool cru, como sempre.
  // Sob RLS isso é fail-closed: a policy não acha país nenhum e devolve 0 linhas.
  if (!session || !session.context || session.released || !isCountryRlsEnabled()) {
    warnIfUnclassified(session);
    return (pool.query as (...a: QueryArgs) => Promise<QueryResult>)(...args);
  }

  const target = dbPoolRoleFor(session.context.kind) === 'system' ? systemPool : pool;
  return runOnSessionClient(target, session, args);
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
