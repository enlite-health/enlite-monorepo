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
import { logger, loggingAls } from '@shared/logging';
import {
  acquireSessionClient,
  currentDbSession,
  dbPoolRoleFor,
  isCountryRlsEnabled,
  type DbSession,
} from './requestDbSession';

type QueryArgs = Parameters<Pool['query']>;

/**
 * Par (runtime, sistema) que este proxy roteia. Chave de SÍMBOLO para não
 * colidir com nada do `pg` nem aparecer em enumeração: quem tem o proxy na mão
 * (`withActorContext`) precisa descobrir de QUAL pool real o client da request
 * saiu, e o proxy é a única coisa que conhece os dois.
 */
const RLS_POOL_PAIR = Symbol.for('enlite.rlsAwarePool.pair');

interface RlsPoolPair {
  runtime: Pool;
  system: Pool;
}

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
      if (prop === RLS_POOL_PAIR) return { runtime: target, system } satisfies RlsPoolPair;
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
 * Pool REAL para onde o contexto atual roteia — dado o pool que o consumidor
 * tem na mão (o proxy de `getPool()`, ou um pool cru, que é ele mesmo).
 *
 * Existe para `withActorContext` poder perguntar "a request já tem client
 * fixado NESTE pool?" sem conhecer a dupla runtime/sistema (ver BLOCKER-3: abrir
 * uma segunda conexão enquanto a request segura a primeira esgota o pool).
 */
export function routedPoolFor(pool: Pool): Pool {
  const pair = (pool as unknown as Record<symbol, RlsPoolPair | undefined>)[RLS_POOL_PAIR];
  if (!pair) return pool;
  return poolForCurrentContext(pair.runtime, pair.system);
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
 * Query que chega ao banco sem classificação — é exatamente a lista que o MODO
 * RELATÓRIO (task 4.2) precisa antes da virada: cada linha destas é uma tela ou
 * job que apagaria sob RLS. Três formas (MEDIUM do review de 14/08 — as duas
 * últimas eram CEGAS antes disto):
 *
 *  1. Request viva sem contexto → um aviso por request, com método + rota
 *     SANITIZADA (`dbSessionMiddleware.sanitizeRoute` — o path cru carrega id e
 *     telefone, que não podem ir pro Cloud Logging).
 *  2. Query DEPOIS da request encerrada (`setImmediate`/`.then` solto que
 *     sobrevive ao `finish`) → o client fixado já voltou; a query sai crua.
 *  3. Query FORA de qualquer request/escopo (`session` nem existe — job legado
 *     sem `withSystemDbContext`).
 *
 * Nas formas 2 e 3 não há request para deduplicar nem rota para logar — a
 * identidade vira o CALL SITE (primeiro frame fora deste diretório), com dedup
 * por site e teto, senão um job em loop inunda o Cloud Logging.
 */
function warnIfUnclassified(session: DbSession | undefined): void {
  if (!session) {
    warnUnscopedQuery('[abac] query fora de request e sem escopo de sistema declarado — sob RLS falharia com 42501 (411: sessão sem identidade é recusada em voz alta, não zero linhas)');
    return;
  }
  if (session.released) {
    warnUnscopedQuery('[abac] query após o fim da request (contexto já liberado) — sob RLS falharia com 42501 (411: sessão sem identidade é recusada em voz alta, não zero linhas)');
    return;
  }
  if (session.context || session.warnedUnclassified) return;
  session.warnedUnclassified = true;
  const store = loggingAls?.getStore?.();
  logger.warn(
    { method: store?.requestMethod, path: store?.requestRoute },
    '[abac] request consultou o banco sem contexto declarado — sob RLS falharia com 42501 (411: sessão sem identidade é recusada em voz alta, não zero linhas)',
  );
}

/** Dedup por call site com teto — o Set nunca cresce sem limite. */
const warnedCallSites = new Set<string>();
const WARNED_CALL_SITES_MAX = 300;

/**
 * Registra a chave e diz se este aviso é inédito. Exportada para o teto ser
 * testável com um Set pequeno — em produção sempre roda com o Set do módulo.
 */
export function shouldWarnOnce(
  key: string,
  registry: Set<string> = warnedCallSites,
  max: number = WARNED_CALL_SITES_MAX,
): boolean {
  if (registry.has(key) || registry.size >= max) return false;
  registry.add(key);
  return true;
}

function warnUnscopedQuery(message: string): void {
  const site = callerOutsideThisDir() ?? 'site-desconhecido';
  if (!shouldWarnOnce(`${site}|${message}`)) return;
  logger.warn({ callSite: site }, message);
}

/**
 * Primeiro frame do stack COM CAMINHO DE ARQUIVO que não é deste diretório nem
 * do node_modules — o código de PRODUTO que fez a query. É o "method + path"
 * das formas 2 e 3. Frames internos (`node:internal`, `<anonymous>` sem
 * caminho) não identificam ninguém e são pulados.
 */
function callerOutsideThisDir(): string | undefined {
  const stack = new Error().stack?.split('\n') ?? [];
  for (const line of stack.slice(1)) {
    if (!line.includes('at ') || !line.includes('/')) continue;
    // Pula a própria fiação (mas NÃO os testes dela, que moram em __tests__).
    if (line.includes('shared/database/') && !line.includes('__tests__')) continue;
    if (line.includes('node_modules') || line.includes('node:internal')) continue;
    return line.trim();
  }
  return undefined;
}

function runOnSessionClient(pool: Pool, session: DbSession, args: QueryArgs): Promise<QueryResult> {
  return acquireSessionClient(pool, session).then((client: PoolClient) =>
    (client.query as (...a: QueryArgs) => Promise<QueryResult>)(...args),
  ) as Promise<QueryResult>;
}
