/**
 * WorkerStatusRepository
 *
 * Extracted from WorkerRepository to stay within the 400-line limit.
 * Contains status-transition logic including the transactional
 * recalculateStatus implementation that atomically updates the worker
 * status and enqueues the domain events when the worker reaches REGISTERED.
 */

import { Pool } from 'pg';
import { WorkerStatus } from '../domain/Worker';
import { logger, loggingAls } from '@shared/logging';
import { enqueueDomainEvent } from '@shared/events/enqueueDomainEvent';
import { recalculateStatus as _recalculateStatus } from './WorkerImportRepository';
import type { PubSubClient } from '@shared/events/PubSubClient';

const MIRROR_TOPIC = 'worker-mirror-requested';
const MIRROR_EVENT = 'worker.mirror_requested';

// worker.registration_completed: dispara PromoteBlockedApplicationsUseCase —
// promove tentativas de postulação bloqueadas (worker_blocked_applications) do
// worker que acabou de completar o cadastro. Ver docs/features/blocked-attempts-modal.
const REGISTRATION_COMPLETED_TOPIC = 'worker-registration-completed';
const REGISTRATION_COMPLETED_EVENT = 'worker.registration_completed';

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
  // ⚠️ C7 — A BAIXA NÃO É RECALCULÁVEL. Este caminho é chamado por UPLOAD e por
  // REVISÃO DE DOCUMENTO (`UploadWorkerDocumentsUseCase`,
  // `ReviewWorkerDocumentsUseCase`), não só por decisão de staff: sem esta
  // guarda, subir um documento de alguém que pediu baixa RESSUSCITA a conta —
  // sem ninguém decidir, sem motivo escrito e sem passar por célula nenhuma.
  //
  // Era o furo mais silencioso dos dois: o outro (DISABLED →
  // INCOMPLETE_REGISTER, em `EncuadreController.updateWorkerStatus`) pelo menos
  // exigia alguém clicar. Reverter baixa é decisão explícita, com motivo — ver
  // `domain/transicaoDeBaixa.ts`.
  const { rows: atual } = await pool.query<{ status: WorkerStatus }>(
    'SELECT status FROM workers WHERE id = $1',
    [workerId],
  );
  if (atual[0]?.status === 'DISABLED') return null;

  const traceId = loggingAls.getStore()?.traceId ?? null;
  let mirrorEventId: string | null = null;
  let registrationCompletedEventId: string | null = null;

  const newStatus = await _recalculateStatus(
    pool,
    workerId,
    async (id, status) => {
      if (status === 'REGISTERED') {
        // Atomic: status UPDATE + both domain_events INSERTs in one transaction.
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
          registrationCompletedEventId = await enqueueDomainEvent(client, {
            event: REGISTRATION_COMPLETED_EVENT,
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

  if (registrationCompletedEventId && pubsub) {
    try {
      await pubsub.publish(REGISTRATION_COMPLETED_TOPIC, { eventId: registrationCompletedEventId });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      logger.child({ workerId, eventId: registrationCompletedEventId }).warn({
        msg: '[WorkerStatusRepository] Pub/Sub publish failed (registration_completed) — sweep will retry',
        error: e.message,
      });
    }
  }

  return newStatus;
}
