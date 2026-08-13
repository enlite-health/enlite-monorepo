/**
 * src/shared/database/requestDbSession.ts
 *
 * Contexto de banco POR REQUEST — é o que faz a RLS de país (migrations 268-272)
 * valer para **LEITURA**, não só para escrita.
 *
 * Por que existe (achado do grupo 3, 13/08): `withActorContext` (D95) cobre
 * escrita — ele abre transação e usa `SET LOCAL`. Mas a leitura do painel é
 * `pool.query` solto: 353 chamadas em 115 pontos que pegam `getPool()`. Sob
 * `app_runtime` (não-owner, task 4.1), uma query sem `app.user_country` setado
 * devolve ZERO linha — o painel inteiro apagaria. Setar o contexto em cada um
 * dos 353 call sites é justamente o modo de falha que a D108 escolheu RLS para
 * eliminar (basta esquecer um). Então o contexto vive no ALS da request e o pool
 * devolvido por `getPool()` o aplica sozinho (ver `rlsAwarePool.ts`).
 *
 * O client é FIXADO na primeira query da request (`session.client`) porque os
 * GUCs valem por CONEXÃO: sem fixar, a segunda query poderia sair por outro
 * client do pool, sem contexto. Ao fim da request o middleware limpa os GUCs e
 * devolve o client; se a limpeza falhar, o client é DESTRUÍDO em vez de voltar
 * ao pool — nunca devolver conexão que ainda carrega o país de alguém.
 *
 * Nada disso muda comportamento enquanto `COUNTRY_RLS_ENABLED` != 'true': o pool
 * segue passando as queries direto (a virada é a task 4.x).
 */

import type { Pool, PoolClient } from 'pg';
import { loggingAls, logger } from '@shared/logging';

/** Jurisdições suportadas — espelha o CHECK das migrations (patients/workers). */
export const COUNTRY_CODES = ['AR', 'BR'] as const;
export type CountryCode = (typeof COUNTRY_CODES)[number];

export function isCountryCode(value: unknown): value is CountryCode {
  return typeof value === 'string' && (COUNTRY_CODES as readonly string[]).includes(value);
}

/**
 * Quem está falando com o banco nesta request.
 *
 * As quatro classes saem do inventário de call sites (task 1.3) e da decisão 9
 * do design — `public` (rotas sem auth) roda como sistema com contexto
 * declarado, não como staff.
 */
export type DbSessionKind = 'staff' | 'worker_self' | 'system' | 'public';

export interface DbSessionContext {
  kind: DbSessionKind;
  /** `firebase_uid` — casa com `user_groups.user_id` na policy de grant. */
  uid?: string;
  /** Só staff. Ausente ⇒ zero linhas (fail-closed) — NUNCA um default 'AR'. */
  country?: CountryCode;
  /** Só system/public: `job:<nome>`, `webhook:<parceiro>`, `public:<rota>`. */
  systemContext?: string;
}

/** Estado vivo da sessão de banco da request (o client fixado mora aqui). */
export interface DbSession {
  context?: DbSessionContext;
  client?: PoolClient;
  /** Aquisição em voo — memoizada para queries concorrentes não pegarem 2 clients. */
  acquiring?: Promise<PoolClient>;
  released: boolean;
  /** Já avisamos que esta request consultou o banco sem classificação? (1 log por request) */
  warnedUnclassified?: boolean;
}

/** GUCs lidos pelas policies da migration 271. */
const GUC_UID = 'app.user_uid';
const GUC_COUNTRY = 'app.user_country';
const GUC_SYSTEM = 'app.system_context';

const APPLY_CONTEXT_SQL = `SELECT
  set_config($1, $2, false),
  set_config($3, $4, false),
  set_config($5, $6, false)`;

const CLEAR_CONTEXT_SQL = `SELECT
  set_config($1, '', false),
  set_config($2, '', false),
  set_config($3, '', false)`;

/** A virada de comportamento é por flag (design, decisão 5). */
export function isCountryRlsEnabled(): boolean {
  return process.env.COUNTRY_RLS_ENABLED === 'true';
}

/** Sessão da request atual, se houver (job fora de request devolve undefined). */
export function currentDbSession(): DbSession | undefined {
  return loggingAls?.getStore?.()?.dbSession;
}

/** Contexto declarado da request atual — usado também por `withActorContext`. */
export function currentDbContext(): DbSessionContext | undefined {
  return currentDbSession()?.context;
}

/**
 * Declara o contexto da request. Chamado pela borda (AuthMiddleware para
 * staff/worker, wrappers de sistema para cron/webhook/público).
 *
 * Sem sessão no ALS é no-op: caminho fora de request não tem o que carimbar.
 */
export function setDbContext(context: DbSessionContext): void {
  const session = currentDbSession();
  if (!session) return;
  session.context = context;
}

/**
 * Aplica o contexto no client e o fixa na sessão. Concorrência: a promessa de
 * aquisição é memoizada, então `Promise.all` de queries usa UM client só.
 */
export async function acquireSessionClient(pool: Pool, session: DbSession): Promise<PoolClient> {
  if (session.client) return session.client;
  if (session.acquiring) return session.acquiring;

  session.acquiring = (async () => {
    const client = await pool.connect();
    try {
      const ctx = session.context;
      await client.query(APPLY_CONTEXT_SQL, [
        GUC_UID,
        ctx?.uid ?? '',
        GUC_COUNTRY,
        ctx?.country ?? '',
        GUC_SYSTEM,
        ctx?.systemContext ?? '',
      ]);
    } catch (err) {
      // Client sem contexto aplicado não volta pro pool: destrói.
      client.release(true);
      session.acquiring = undefined;
      throw err;
    }
    session.client = client;
    session.acquiring = undefined;
    return client;
  })();

  return session.acquiring;
}

/**
 * Fim da request: limpa os GUCs e devolve o client. Falhou a limpeza? o client é
 * DESTRUÍDO (`release(true)`) — devolver ao pool uma conexão que ainda carrega
 * país seria vazamento entre requests, a falha que esta change existe pra evitar.
 */
export async function releaseDbSession(session: DbSession): Promise<void> {
  if (session.released) return;
  session.released = true;

  if (session.acquiring) {
    try {
      await session.acquiring;
    } catch {
      /* a aquisição já destruiu o client dela */
    }
  }

  const client = session.client;
  session.client = undefined;
  if (!client) return;

  try {
    await client.query(CLEAR_CONTEXT_SQL, [GUC_UID, GUC_COUNTRY, GUC_SYSTEM]);
    client.release();
  } catch (err) {
    logger.error(
      { err, kind: session.context?.kind },
      '[abac] falha ao limpar contexto de país — client destruído em vez de devolvido ao pool',
    );
    try {
      client.release(true);
    } catch {
      /* client já perdido */
    }
  }
}

/**
 * Roda `fn` sob contexto de SISTEMA declarado (task 3.3) — crons, webhooks,
 * filas, capabilities MCP e rotas públicas.
 *
 * Dentro de uma request (webhook) só carimba o contexto na sessão existente;
 * fora dela (cron/worker de fila) abre um escopo de ALS próprio e libera o
 * client no fim. `label` vai inteiro para `app.system_context` e aparece no
 * `resource_access_log` — usar `job:<nome>` / `webhook:<parceiro>` /
 * `public:<rota>`, nunca vazio (a policy exige valor não-vazio).
 */
export async function withSystemDbContext<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (!label.trim()) {
    throw new Error('[abac] withSystemDbContext exige um rótulo (ex.: "job:checkin")');
  }
  const context: DbSessionContext = { kind: 'system', systemContext: label };

  // Sessão JÁ ENCERRADA não serve (é o caso da trilha de leitura, que grava
  // depois do `finish` da resposta mas ainda dentro do ALS daquela request):
  // reusá-la mandaria a query pro pool cru, sem contexto — zero linha sob RLS.
  const existing = currentDbSession();
  if (existing && !existing.released) {
    existing.context = context;
    return fn();
  }

  const session: DbSession = { context, released: false };
  const parent = loggingAls?.getStore?.();
  try {
    return await loggingAls.run({ traceId: parent?.traceId ?? `system:${label}`, dbSession: session }, fn);
  } finally {
    await releaseDbSession(session);
  }
}
