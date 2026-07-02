/**
 * enqueueDomainEvent — generic outbox helper
 *
 * Inserts a row into `domain_events` and, optionally, publishes a Pub/Sub
 * notification so the push-subscription delivers it immediately instead of
 * waiting for the periodic sweep.
 *
 * Design principles:
 * - Accepts both `Pool` and `PoolClient` so callers can include the INSERT
 *   inside an existing transaction (pass the PoolClient) or run it standalone
 *   (pass the Pool).
 * - Publish failure is best-effort: it is caught, logged as WARN, and never
 *   re-thrown. The DomainEventProcessor sweep is the durability safety net.
 * - Returns the new event UUID so callers can publish it; returns null only
 *   when the INSERT itself throws (caller decides whether to surface that error
 *   or swallow it — this function always re-throws INSERT errors).
 */

import type { Pool, PoolClient } from 'pg';
import { logger } from '@shared/logging';
import type { PubSubClient } from './PubSubClient';

/** Subset of pg that both Pool and PoolClient satisfy for a single query. */
interface Queryable {
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<{ id: string }> }>;
}

export interface EnqueueDomainEventParams {
  /** Domain event name, e.g. 'worker.mirror_requested'. */
  event: string;
  /** Arbitrary JSON payload; must be serialisable. */
  payload: Record<string, unknown>;
  /** Correlation trace ID propagated from loggingAls (may be null). */
  traceId?: string | null;
  /** When provided, a best-effort Pub/Sub publish is attempted after INSERT. */
  pubsub?: PubSubClient;
  /** Pub/Sub topic name. Required when `pubsub` is supplied. */
  topic?: string;
}

/**
 * Inserts one domain_event row and optionally publishes to Pub/Sub.
 *
 * @param db  Pool or PoolClient — use PoolClient for transactional callers.
 * @returns   The new event UUID string.
 * @throws    Re-throws INSERT errors. Publish errors are swallowed (logged as WARN).
 */
export async function enqueueDomainEvent(
  db: Pool | PoolClient,
  params: EnqueueDomainEventParams,
): Promise<string> {
  const { event, payload, traceId = null, pubsub, topic } = params;

  const result = await (db as Queryable).query(
    `INSERT INTO domain_events (event, payload, trace_id)
     VALUES ($1, $2::jsonb, $3)
     RETURNING id`,
    [event, JSON.stringify(payload), traceId],
  );

  const eventId: string = result.rows[0].id;

  if (pubsub && topic) {
    try {
      await pubsub.publish(topic, { eventId });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      logger.child({ event, eventId, topic }).warn({
        msg: '[enqueueDomainEvent] Pub/Sub publish failed — sweep will retry',
        error: e.message,
      });
    }
  }

  return eventId;
}
