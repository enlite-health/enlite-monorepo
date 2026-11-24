/**
 * WorkerStatusTransitions — o ÚNICO lugar de `src/` que faz `UPDATE workers SET status` (spec 093, DF-2/DF-4).
 *
 * Toda escrita carimba `app.status_flow` (set_config LOCAL à transação) na MESMA transação e ANTES do UPDATE;
 * o trigger da migration 591 recusa o UPDATE sem fluxo e o log grava `flow` + `changed_by`.
 * Status derivado (REGISTERED / INCOMPLETE_REGISTER) só sai de `recalculate*`; o não derivado, só de
 * `disable` / `restoreFromDisabled` (e `setStatus`, decisão explícita de staff — ADMIN_STATUS_CHANGE).
 */

import type { Pool, PoolClient } from 'pg';
import type { WorkerStatus } from '../domain/Worker';
import type { WorkerStatusFlow } from '../domain/WorkerStatusFlow';
import { logger, loggingAls } from '@shared/logging';
import { enqueueDomainEvent } from '@shared/events/enqueueDomainEvent';
import { withActorContext } from '@shared/database/actorContext';
import type { ActorContext } from '@shared/audit/actorSource';
import type { PubSubClient } from '@shared/events/PubSubClient';
import { recalculateStatus as _recalculateStatus } from './WorkerImportRepository';

const MIRROR_TOPIC = 'worker-mirror-requested';
const MIRROR_EVENT = 'worker.mirror_requested';

// worker.registration_completed: dispara PromoteBlockedApplicationsUseCase — promove tentativas de
// postulação bloqueadas do worker que acabou de completar o cadastro.
const REGISTRATION_COMPLETED_TOPIC = 'worker-registration-completed';
const REGISTRATION_COMPLETED_EVENT = 'worker.registration_completed';

/** `flow` é OBRIGATÓRIO e sem default: default seria um "UNDECLARED" disfarçado (§9.2). */
export type WorkerStatusTransitionCtx = {
  flow: WorkerStatusFlow;
  actor?: ActorContext;
  pubsub?: PubSubClient | null;
};

export type WorkerStatusEventIds = {
  mirror: string | null;
  registrationCompleted: string | null;
};

export type RecalculateInTransactionResult = {
  newStatus: WorkerStatus | null;
  eventIds: WorkerStatusEventIds;
};

const NO_EVENTS: WorkerStatusEventIds = { mirror: null, registrationCompleted: null };

/** set_config LOCAL do fluxo — SEMPRE antes do UPDATE, no mesmo client/transação. */
async function declareFlow(client: PoolClient, flow: WorkerStatusFlow): Promise<void> {
  await client.query(`SELECT set_config('app.status_flow', $1, true)`, [flow]);
}

/** Carimbo de ator para quem já está numa transação alheia (withActorContext faz o seu no BEGIN). */
async function stampActor(client: PoolClient, actor: ActorContext | undefined): Promise<void> {
  if (!actor) return;
  await client.query(`SELECT set_config('app.current_uid', $1, true)`, [actor.id]);
  await client.query(`SELECT set_config('app.change_source', $1, true)`, [actor.source]);
}

async function writeStatus(
  client: PoolClient,
  workerId: string,
  status: WorkerStatus,
  flow: WorkerStatusFlow,
): Promise<void> {
  await declareFlow(client, flow);
  await client.query('UPDATE workers SET status = $2, updated_at = NOW() WHERE id = $1', [
    workerId,
    status,
  ]);
}

/** Núcleo único do recálculo; assume transação aberta e ator já carimbado. */
async function recalculateCore(
  client: PoolClient,
  workerId: string,
  flow: WorkerStatusFlow,
): Promise<RecalculateInTransactionResult> {
  // ⚠️ C7 — A BAIXA NÃO É RECALCULÁVEL. Este caminho é chamado por UPLOAD e por REVISÃO DE DOCUMENTO,
  // não só por decisão de staff: sem esta guarda, subir um documento de quem pediu baixa RESSUSCITA a
  // conta — sem ninguém decidir, sem motivo escrito e sem passar por célula nenhuma. Reverter baixa é
  // decisão explícita, com motivo (`restoreFromDisabled`, ver `domain/transicaoDeBaixa.ts`).
  const { rows: atual } = await client.query<{ status: WorkerStatus }>(
    'SELECT status FROM workers WHERE id = $1',
    [workerId],
  );
  if (atual[0]?.status === 'DISABLED') return { newStatus: null, eventIds: NO_EVENTS };

  const traceId = loggingAls.getStore()?.traceId ?? null;
  const eventIds: WorkerStatusEventIds = { mirror: null, registrationCompleted: null };

  // SUP-T006-2: `_recalculateStatus` só usa `pool.query`; o client da transação serve no lugar do pool
  // (cast conservador — semântica de completude intocada).
  const newStatus = await _recalculateStatus(
    client as unknown as Pool,
    workerId,
    async (id, status) => {
      await writeStatus(client, id, status, flow);
      if (status === 'REGISTERED') {
        // Atômico: UPDATE de status + os 2 domain_events na MESMA transação.
        eventIds.mirror = await enqueueDomainEvent(client, {
          event: MIRROR_EVENT,
          payload: { workerId: id },
          traceId,
        });
        eventIds.registrationCompleted = await enqueueDomainEvent(client, {
          event: REGISTRATION_COMPLETED_EVENT,
          payload: { workerId: id },
          traceId,
        });
      }
    },
  );
  return { newStatus, eventIds };
}

async function publishBestEffort(
  topic: string,
  eventId: string,
  workerId: string,
  pubsub: PubSubClient,
  label: string,
): Promise<void> {
  try {
    await pubsub.publish(topic, { eventId });
  } catch (err: unknown) {
    const e = err instanceof Error ? err : new Error(String(err));
    logger.child({ workerId, eventId }).warn({
      msg: `[WorkerStatusTransitions] Pub/Sub publish failed${label} — sweep will retry`,
      error: e.message,
    });
  }
}

/**
 * Publica no Pub/Sub os eventos enfileirados por `recalculateInTransaction` — chamar DEPOIS do COMMIT.
 * Best-effort: falha vira WARN e nunca é relançada (o sweep do DomainEventProcessor é a rede de segurança).
 */
export async function publishStatusEventsAfterCommit(
  workerId: string,
  eventIds: WorkerStatusEventIds,
  pubsub: PubSubClient | null | undefined,
): Promise<void> {
  if (!pubsub) return;
  if (eventIds.mirror) {
    await publishBestEffort(MIRROR_TOPIC, eventIds.mirror, workerId, pubsub, '');
  }
  if (eventIds.registrationCompleted) {
    await publishBestEffort(
      REGISTRATION_COMPLETED_TOPIC,
      eventIds.registrationCompleted,
      workerId,
      pubsub,
      ' (registration_completed)',
    );
  }
}

/**
 * Recalcula dentro de uma transação que o CHAMADOR controla (sem BEGIN/COMMIT aqui).
 * Os eventos ficam enfileirados no client; o chamador publica após o COMMIT com
 * `publishStatusEventsAfterCommit`.
 */
export async function recalculateInTransaction(
  client: PoolClient,
  workerId: string,
  ctx: WorkerStatusTransitionCtx,
): Promise<RecalculateInTransactionResult> {
  await stampActor(client, ctx.actor);
  return recalculateCore(client, workerId, ctx.flow);
}

/**
 * Recalcula o status em transação própria; quando vira REGISTERED, UPDATE + domain_events saem juntos.
 * @returns o novo status se mudou, ou null.
 */
export async function recalculate(
  pool: Pool,
  workerId: string,
  ctx: WorkerStatusTransitionCtx,
): Promise<WorkerStatus | null> {
  const { newStatus, eventIds } = await withActorContext(
    pool,
    (client) => recalculateCore(client, workerId, ctx.flow),
    ctx.actor,
  );
  await publishStatusEventsAfterCommit(workerId, eventIds, ctx.pubsub);
  return newStatus;
}

/** Escrita explícita de status por decisão de staff (ADMIN_STATUS_CHANGE) — transação própria. */
export async function setStatus(
  pool: Pool,
  workerId: string,
  status: WorkerStatus,
  ctx: WorkerStatusTransitionCtx,
): Promise<void> {
  await withActorContext(pool, (client) => writeStatus(client, workerId, status, ctx.flow), ctx.actor);
}

/** DF-2: baixa. Transação do chamador. */
export async function disable(
  client: PoolClient,
  workerId: string,
  ctx: WorkerStatusTransitionCtx,
): Promise<void> {
  await stampActor(client, ctx.actor);
  await writeStatus(client, workerId, 'DISABLED', ctx.flow);
}

/**
 * DF-2/DF-10: sai da baixa. Grava INCOMPLETE_REGISTER e recalcula no MESMO client (pode virar REGISTERED).
 * Transação do chamador; publicar os eventos depois do COMMIT.
 */
export async function restoreFromDisabled(
  client: PoolClient,
  workerId: string,
  ctx: WorkerStatusTransitionCtx,
): Promise<RecalculateInTransactionResult> {
  await stampActor(client, ctx.actor);
  await writeStatus(client, workerId, 'INCOMPLETE_REGISTER', ctx.flow);
  return recalculateCore(client, workerId, ctx.flow);
}
