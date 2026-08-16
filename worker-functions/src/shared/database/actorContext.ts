/**
 * src/shared/database/actorContext.ts
 *
 * Roda escritas dentro de uma transação que carimba QUEM está escrevendo.
 *
 * Os triggers `fn_log_worker_status_change` e `fn_log_application_stage_change`
 * gravam o histórico lendo o setting de sessão `app.current_uid` →
 * `worker_*_history.changed_by`.
 *
 * A identidade carrega a fonte no PREFIXO (`staff:`, `luz:`, `worker_self`,
 * `system:`, `sync:`) — de propósito: assim a medição não depende de alterar os
 * triggers em produção. `app.change_source` também é setado, para a coluna
 * `change_source` (hoje sempre NULL) ser aproveitável se um dia os triggers
 * passarem a lê-la; enquanto isso é inofensivo.
 *
 * `set_config(..., true)` é LOCAL À TRANSAÇÃO — por isso as queries precisam
 * rodar no mesmo client, e não em `pool.query` soltos. Esta função generaliza o
 * que `DeactivateWorkerAccountUseCase` e `UpdateWorkerProfileFieldsUseCase` já
 * faziam à mão.
 *
 * Sem ator (explícito ou no ALS) a transação roda igual, só sem carimbo — o
 * comportamento de hoje. Nunca falhar uma escrita por causa de auditoria.
 */

import type { Pool, PoolClient } from 'pg';
import { loggingAls } from '@shared/logging';
import type { ActorContext } from '@shared/audit/actorSource';
import { currentDbContext, currentDbSession, sessionClientOrPending } from './requestDbSession';
import { routedPoolFor } from './rlsAwarePool';

/**
 * Ator do contexto atual: o explícito ganha do que veio da request (ALS).
 *
 * `loggingAls?.` de propósito (mesmo padrão de WorkerAuditRepository): fora de
 * uma request — e em teste com `@shared/logging` mockado — o ALS pode nem
 * existir, e auditoria nunca pode derrubar a escrita.
 */
export function resolveActor(override?: ActorContext | null): ActorContext | null {
  return override ?? loggingAls?.getStore?.()?.actor ?? null;
}

/**
 * Carimba o contexto de PAÍS na transação (ABAC Fase 1, task 3.1).
 *
 * `SET LOCAL` (`set_config(..., true)`) porque o client da transação pode vir do
 * pool cru — aí ele chega sem contexto e não pode levar contexto embora ao ser
 * devolvido. Quando o client É o fixado da request (que já tem os GUCs no escopo
 * de sessão), reaplicar LOCAL é idempotente: mesmos valores, revertidos ao valor
 * de sessão no COMMIT.
 *
 * A IDENTIDADE da conexão vem do `connect()` do pool recebido: quem passa o pool
 * de `getPool()` (todos os call sites de produção) recebe, sob contexto
 * `system`/`public`, um client do pool de sistema — sem isso a transação sairia
 * como `app_runtime` e o `app.system_context` não valeria nada. Ver
 * `rlsAwarePool.ts`.
 *
 * Sem contexto declarado (job legado ainda não classificado) a transação roda
 * como sempre: sob RLS isso é fail-closed (zero linhas), nunca permissivo.
 */
async function applyCountryContext(client: PoolClient): Promise<void> {
  const ctx = currentDbContext();
  if (!ctx) return;
  await client.query(
    `SELECT set_config('app.user_uid', $1, true),
            set_config('app.user_country', $2, true),
            set_config('app.system_context', $3, true)`,
    [ctx.uid ?? '', ctx.country ?? '', ctx.systemContext ?? ''],
  );
}

/**
 * Client que a request JÁ tem fixado no pool para onde este contexto roteia —
 * ou `undefined` (sem sessão viva, sem client fixado, flag off).
 *
 * ⚠️ BLOCKER-3 (deadlock de pool): a request de leitura FIXA um client até o
 * `finish` da resposta. Se a escrita no meio dela pedisse um SEGUNDO client
 * (`pool.connect()`), cada request em voo consumiria duas conexões — com
 * `DB_POOL_MAX=20` e concorrência maior que 10, as escritas passariam a morrer
 * em `connectionTimeoutMillis` sem que nada no código parecesse errado.
 */
async function pinnedClientFor(pool: Pool): Promise<PoolClient | undefined> {
  const session = currentDbSession();
  if (!session || session.released) return undefined;
  // Inclui aquisição EM VOO (MEDIUM 14/08): `Promise.all(leitura, escrita)` na
  // primeira operação da request deixava `slot.client` ainda vazio e esta função
  // devolvia undefined — a escrita abria a SEGUNDA conexão da request, o mesmo
  // esgotamento do BLOCKER-3. Se a aquisição em voo falhar, cai para `undefined`
  // e o caller abre conexão própria (a falha dela já destruiu o client).
  const pinned = sessionClientOrPending(session, routedPoolFor(pool));
  if (!pinned) return undefined;
  try {
    return await pinned;
  } catch {
    return undefined;
  }
}

/**
 * Abre transação, carimba o ator e roda `fn`. Commit no sucesso, rollback em
 * qualquer erro (o erro é repropagado — quem chama decide o que fazer).
 *
 * Se a request já tem um client fixado no pool roteado, a transação roda NELE e
 * o client NÃO é devolvido aqui (ele pertence à sessão; quem devolve é o
 * `dbSessionMiddleware` no fim da request).
 *
 * TRADE-OFF ACEITO ao reusar o client fixado: as leituras soltas da mesma
 * request passam a rodar DENTRO desta transação (o `pg` serializa por conexão),
 * então um erro delas aborta a transação da escrita. É aceitável porque o
 * handler Express é sequencial por padrão — a leitura concorrente com a escrita
 * na mesma request é a exceção, não a regra — e porque a alternativa (segunda
 * conexão por request) é o esgotamento de pool descrito acima. A medição de
 * concorrência real é gate da task 4.1 (staging).
 *
 * @param actor ator explícito; omitido, usa o da request (ALS).
 */
export async function withActorContext<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
  actor?: ActorContext | null,
): Promise<T> {
  const resolved = resolveActor(actor);
  const pinned = await pinnedClientFor(pool);
  const client = pinned ?? (await pool.connect());
  try {
    await client.query('BEGIN');
    if (resolved) {
      await client.query(`SELECT set_config('app.current_uid', $1, true)`, [resolved.id]);
      await client.query(`SELECT set_config('app.change_source', $1, true)`, [resolved.source]);
    }
    await applyCountryContext(client);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* conexão já perdida — o rollback é implícito */
    }
    throw err;
  } finally {
    // Client da sessão não se devolve aqui: ele é da request, não da transação.
    if (!pinned) client.release();
  }
}
