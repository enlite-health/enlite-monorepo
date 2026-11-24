/**
 * WorkerStatusRepository — fachada fina sobre WorkerStatusTransitions (spec 093).
 *
 * NÃO contém UPDATE: o único escritor de workers.status é WorkerStatusTransitions.
 * `ctx` (com `flow`) é obrigatório, sem default.
 */

import { Pool } from 'pg';
import { WorkerStatus } from '../domain/Worker';
import {
  recalculate,
  setStatus,
  type WorkerStatusTransitionCtx,
} from './WorkerStatusTransitions';

export type { WorkerStatusTransitionCtx } from './WorkerStatusTransitions';

export async function updateWorkerStatus(
  pool: Pool,
  workerId: string,
  status: WorkerStatus,
  ctx: WorkerStatusTransitionCtx,
): Promise<void> {
  return setStatus(pool, workerId, status, ctx);
}

/** @returns o novo WorkerStatus se mudou, ou null. `ctx.pubsub` publica best-effort após o COMMIT. */
export async function recalculateWorkerStatus(
  pool: Pool,
  workerId: string,
  ctx: WorkerStatusTransitionCtx,
): Promise<WorkerStatus | null> {
  return recalculate(pool, workerId, ctx);
}
