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
 * O client é FIXADO na primeira query da request (um slot por pool) porque os
 * GUCs valem por CONEXÃO: sem fixar, a segunda query poderia sair por outro
 * client do pool, sem contexto. Ao fim da request o middleware limpa os GUCs e
 * devolve o client; se a limpeza falhar, o client é DESTRUÍDO em vez de voltar
 * ao pool — nunca devolver conexão que ainda carrega o país de alguém.
 *
 * DUAS IDENTIDADES (task 3.2): a classe da request escolhe de QUAL pool o client
 * sai — `staff`/`worker_self` do pool de runtime (`app_runtime`, confinado ao
 * país), `system`/`public` do pool de sistema (`app_system`, o atalho declarado).
 * A sessão guarda um slot POR POOL, então uma request que troca de contexto no
 * meio (webhook que chama `withSystemDbContext`) não reaproveita o client errado
 * nem devolve conexão para o pool errado. Quando os dois pools são o MESMO
 * objeto (envs de sistema ausentes = configuração de hoje), há um slot só.
 *
 * Nada disso muda comportamento enquanto `COUNTRY_RLS_ENABLED` != 'true': o pool
 * segue passando as queries direto (a virada é a task 4.x).
 */

import type { Pool, PoolClient } from 'pg';
import { loggingAls, logger } from '@shared/logging';
import { COUNTRY_CODES, isCountryCode, type CountryCode } from '@shared/domain/countryCodes';

/**
 * Jurisdições suportadas — FONTE ÚNICA em `@shared/domain/countryCodes` (D108).
 * Re-exportadas aqui porque os call sites do ABAC importam daqui desde a task
 * 3.1; a lista em si não mora mais neste arquivo (era literal duplicada de
 * `ADMISSION_COUNTRY_CODES`).
 */
export { COUNTRY_CODES, isCountryCode };
export type { CountryCode };

/**
 * Quem está falando com o banco nesta request.
 *
 * As quatro classes saem do inventário de call sites (task 1.3) e da decisão 9
 * do design — `public` (rotas sem auth) roda como sistema com contexto
 * declarado, não como staff.
 */
export type DbSessionKind = 'staff' | 'worker_self' | 'system' | 'public';

/** Identidade de banco usada pela request. */
export type DbPoolRole = 'runtime' | 'system';

/**
 * Classe da request → identidade de banco.
 *
 * `worker_self` fica no pool de RUNTIME de propósito (decisão de design v1): o
 * prestador não é membro de `app_system`, então sob RLS ele é fail-closed nas
 * tabelas protegidas. Dar-lhe o atalho de sistema resolveria a tela às custas de
 * abrir os dois países para o público — o oposto do que a change existe pra fazer.
 */
export function dbPoolRoleFor(kind: DbSessionKind | undefined): DbPoolRole {
  return kind === 'system' || kind === 'public' ? 'system' : 'runtime';
}

export interface DbSessionContext {
  kind: DbSessionKind;
  /** `firebase_uid` — casa com `user_groups.user_id` na policy de grant. */
  uid?: string;
  /** Só staff. Ausente ⇒ zero linhas (fail-closed) — NUNCA um default 'AR'. */
  country?: CountryCode;
  /** Só system/public: `job:<nome>`, `webhook:<parceiro>`, `public:<rota>`. */
  systemContext?: string;
}

/** Client fixado de UM pool (a sessão pode ter um por identidade). */
export interface DbSessionSlot {
  client?: PoolClient;
  /** Aquisição em voo — memoizada para queries concorrentes não pegarem 2 clients. */
  acquiring?: Promise<PoolClient>;
  /**
   * Assinatura do contexto JÁ APLICADO neste client (uid+país+system_context).
   * Sem ela, uma request que troca de contexto no meio e volta a cair no MESMO
   * slot (configuração de pool único: staff → `withSystemDbContext` → staff)
   * reusaria o client com os GUCs do contexto ANTERIOR — a query de sistema
   * rodaria carimbada com o país do staff, e a de staff depois dela com o
   * `system_context` do job. Divergiu, reaplica antes de devolver o client.
   */
  appliedContext?: string;
}

/** Estado vivo da sessão de banco da request (os clients fixados moram aqui). */
export interface DbSession {
  context?: DbSessionContext;
  /**
   * Um slot por POOL (não por classe): pools idênticos — a configuração de hoje,
   * sem envs de sistema — compartilham o mesmo slot e a mesma conexão.
   */
  slots?: Map<Pool, DbSessionSlot>;
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

function slotFor(session: DbSession, pool: Pool): DbSessionSlot {
  if (!session.slots) session.slots = new Map();
  let slot = session.slots.get(pool);
  if (!slot) {
    slot = {};
    session.slots.set(pool, slot);
  }
  return slot;
}

/** Client já fixado para este pool nesta sessão (introspecção e testes). */
export function sessionClientFor(session: DbSession, pool: Pool): PoolClient | undefined {
  return session.slots?.get(pool)?.client;
}

/**
 * Assinatura do contexto — o que precisa estar setado na conexão.
 * `JSON.stringify` e não concatenação: uid e rótulo de sistema são strings
 * livres, e um separador escolhido a dedo abriria a chance de dois contextos
 * diferentes gerarem a mesma assinatura (e a reaplicação ser pulada).
 */
function contextFingerprint(context: DbSessionContext | undefined): string {
  return JSON.stringify([context?.uid ?? '', context?.country ?? '', context?.systemContext ?? '']);
}

/** Escreve os três GUCs no client (escopo de SESSÃO — `set_config(..., false)`). */
async function applyContext(client: PoolClient, context: DbSessionContext | undefined): Promise<void> {
  await client.query(APPLY_CONTEXT_SQL, [
    GUC_UID,
    context?.uid ?? '',
    GUC_COUNTRY,
    context?.country ?? '',
    GUC_SYSTEM,
    context?.systemContext ?? '',
  ]);
}

/**
 * Devolve o client do slot, REAPLICANDO os GUCs se o contexto da sessão mudou
 * desde a última aplicação. O custo (um round-trip) só aparece quando a request
 * de fato trocou de contexto; no caso comum a assinatura bate e não há query.
 */
async function withCurrentContext(
  slot: DbSessionSlot,
  client: PoolClient,
  session: DbSession,
): Promise<PoolClient> {
  const wanted = contextFingerprint(session.context);
  if (slot.appliedContext === wanted) return client;
  await applyContext(client, session.context);
  slot.appliedContext = wanted;
  return client;
}

/**
 * Aplica o contexto no client e o fixa na sessão, no slot DESTE pool.
 * Concorrência: a promessa de aquisição é memoizada por slot, então
 * `Promise.all` de queries da mesma identidade usa UM client só.
 */
export async function acquireSessionClient(pool: Pool, session: DbSession): Promise<PoolClient> {
  const slot = slotFor(session, pool);
  if (slot.client) return withCurrentContext(slot, slot.client, session);
  if (slot.acquiring) return slot.acquiring.then((client) => withCurrentContext(slot, client, session));

  const wanted = contextFingerprint(session.context);
  slot.acquiring = (async () => {
    const client = await pool.connect();
    try {
      await applyContext(client, session.context);
    } catch (err) {
      // Client sem contexto aplicado não volta pro pool: destrói.
      client.release(true);
      slot.acquiring = undefined;
      throw err;
    }
    slot.client = client;
    slot.appliedContext = wanted;
    slot.acquiring = undefined;
    return client;
  })();

  return slot.acquiring;
}

/**
 * Fim da request: limpa os GUCs e devolve CADA client fixado ao SEU pool.
 * Falhou a limpeza? o client é DESTRUÍDO (`release(true)`) — devolver ao pool
 * uma conexão que ainda carrega país seria vazamento entre requests, a falha que
 * esta change existe pra evitar.
 */
export async function releaseDbSession(session: DbSession): Promise<void> {
  if (session.released) return;
  session.released = true;

  const slots = session.slots ? [...session.slots.values()] : [];
  session.slots = undefined;
  await Promise.all(slots.map((slot) => releaseSlot(session, slot)));
}

async function releaseSlot(session: DbSession, slot: DbSessionSlot): Promise<void> {
  if (slot.acquiring) {
    try {
      await slot.acquiring;
    } catch {
      /* a aquisição já destruiu o client dela */
    }
  }

  const client = slot.client;
  slot.client = undefined;
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
 *
 * O contexto anterior é RESTAURADO ao sair. Com dois pools isso deixou de ser
 * cosmético: sem restaurar, uma request de staff que gravasse a trilha de acesso
 * no meio do caminho passaria a rotear TODAS as queries seguintes pelo pool de
 * sistema — staff lendo os dois países por efeito colateral de auditoria.
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
    const previous = existing.context;
    existing.context = context;
    try {
      return await fn();
    } finally {
      existing.context = previous;
    }
  }

  const session: DbSession = { context, released: false };
  const parent = loggingAls?.getStore?.();
  try {
    return await loggingAls.run({ traceId: parent?.traceId ?? `system:${label}`, dbSession: session }, fn);
  } finally {
    await releaseDbSession(session);
  }
}
