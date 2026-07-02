/**
 * WorkerStatusRepository
 *
 * Extracted from WorkerRepository to stay within the 400-line limit.
 * Contains status-transition logic including the transactional
 * recalculateStatus implementation that atomically updates the worker
 * status and enqueues the domain event when the worker reaches REGISTERED.
 */

import { Pool } from 'pg';
import { WorkerStatus } from '../domain/Worker';
import { logger, loggingAls } from '@shared/logging';
import { enqueueDomainEvent } from '@shared/events/enqueueDomainEvent';
import { recalculateStatus as _recalculateStatus } from './WorkerImportRepository';
import type { PubSubClient } from '@shared/events/PubSubClient';

const MIRROR_TOPIC = 'worker-mirror-requested';
const MIRROR_EVENT = 'worker.mirror_requested';

/**
 * Updates a single worker's status inside its own transaction.
 * Extracted so it can be reused by recalculateRegisteredStatus
 * for non-REGISTERED transitions.
 */
export async function updateWorkerStatus(
  pool: Pool,
  workerId: string,
  status: WorkerStatus,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE workers SET status = $2, updated_at = NOW() WHERE id = $1',
      [workerId, status],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Recalculates a worker's status and, when the new status is REGISTERED,
 * atomically writes the domain_events row in the SAME transaction as the
 * status UPDATE — guaranteeing that either both commit or neither does.
 *
 * After the transaction commits, publishes to Pub/Sub best-effort:
 * publish failure is logged as WARN and never rethrown; the
 * DomainEventProcessor sweep provides the durability safety net.
 *
 * For non-REGISTERED transitions the status update runs in its own
 * transaction without a domain event (no mirror needed).
 *
 * @returns The new WorkerStatus if it changed, or null if unchanged.
 */
export async function recalculateWorkerStatus(
  pool: Pool,
  workerId: string,
  pubsub: PubSubClient | null,
): Promise<WorkerStatus | null> {
  const traceId = loggingAls.getStore()?.traceId ?? null;
  let mirrorEventId: string | null = null;

  const newStatus = await _recalculateStatus(
    pool,
    workerId,
    async (id, status) => {
      if (status === 'REGISTERED') {
        // Atomic: status UPDATE + domain_events INSERT in one transaction.
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(
            'UPDATE workers SET status = $2, updated_at = NOW() WHERE id = $1',
            [id, status],
          );
          mirrorEventId = await enqueueDomainEvent(client, {
            event: MIRROR_EVENT,
            payload: { workerId: id },
            traceId,
          });
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }
      } else {
        await updateWorkerStatus(pool, id, status);
      }
    },
  );

  // Pub/Sub publish is best-effort — runs after the transaction commits.
  if (mirrorEventId && pubsub) {
    try {
      await pubsub.publish(MIRROR_TOPIC, { eventId: mirrorEventId });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      logger.child({ workerId, eventId: mirrorEventId }).warn({
        msg: '[WorkerStatusRepository] Pub/Sub publish failed — sweep will retry',
        error: e.message,
      });
    }
  }

  return newStatus;
}
