import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { loggingAls } from '@shared/logging';

export type DomainEventHandler = (payload: Record<string, unknown>) => Promise<void>;

/**
 * Processes domain events from the `domain_events` table.
 * Called by Pub/Sub push (immediate) or safety-net sweep (fallback).
 *
 * Idempotent: ignores already-processed events.
 */
export class DomainEventProcessor {
  private handlers = new Map<string, DomainEventHandler>();

  constructor(private readonly pool: Pool) {}

  registerHandler(eventName: string, handler: DomainEventHandler): void {
    this.handlers.set(eventName, handler);
  }

  /**
   * Process a single domain event by ID.
   * Called from Pub/Sub push → POST /api/internal/events/process
   */
  async processEvent(eventId: string): Promise<{ status: 'processed' | 'skipped' | 'failed'; event?: string }> {
    const client = await this.pool.connect();
    try {
      // Fetch event — skip if already processed
      const { rows } = await client.query(
        `SELECT id, event, payload, status, trace_id FROM domain_events WHERE id = $1`,
        [eventId],
      );

      if (rows.length === 0) {
        console.warn(`[DomainEventProcessor] Event ${eventId} not found`);
        return { status: 'skipped' };
      }

      const row = rows[0] as {
        id: string;
        event: string;
        payload: Record<string, unknown>;
        status: string;
        trace_id: string | null;
      };
      if (row.status === 'processed') {
        console.log(`[DomainEventProcessor] Event ${eventId} already processed, skipping`);
        return { status: 'skipped', event: row.event };
      }

      const handler = this.handlers.get(row.event);
      if (!handler) {
        console.warn(`[DomainEventProcessor] No handler for event "${row.event}"`);
        await client.query(
          `UPDATE domain_events SET status = 'failed', error = $2, processed_at = NOW() WHERE id = $1`,
          [eventId, `No handler registered for event "${row.event}"`],
        );
        return { status: 'failed', event: row.event };
      }

      // Execute handler inside ALS context so logs carry the trace ID
      try {
        await loggingAls.run(
          { traceId: row.trace_id ?? uuidv4() },
          () => handler(row.payload),
        );
        await client.query(
          `UPDATE domain_events SET status = 'processed', processed_at = NOW() WHERE id = $1`,
          [eventId],
        );
        console.log(`[DomainEventProcessor] Processed event ${eventId} (${row.event})`);
        return { status: 'processed', event: row.event };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        await client.query(
          `UPDATE domain_events SET status = 'failed', error = $2, processed_at = NOW() WHERE id = $1`,
          [eventId, errorMsg],
        );
        console.error(`[DomainEventProcessor] Handler failed for event ${eventId}:`, errorMsg);
        return { status: 'failed', event: row.event };
      }
    } finally {
      client.release();
    }
  }

  /**
   * Safety net: reprocess orphan events that were never picked up by Pub/Sub.
   * Called periodically via Cloud Scheduler → /api/internal/events/sweep
   */
  async sweepPendingEvents(olderThanMinutes = 5, limit = 50): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT id FROM domain_events
       WHERE status = 'pending'
         AND created_at < NOW() - INTERVAL '1 minute' * $1
       ORDER BY created_at ASC
       LIMIT $2`,
      [olderThanMinutes, limit],
    );

    let processed = 0;
    for (const row of rows) {
      const result = await this.processEvent(row.id);
      if (result.status === 'processed') processed++;
    }

    if (rows.length > 0) {
      console.log(`[DomainEventProcessor] Sweep: ${processed}/${rows.length} events processed`);
    }
    return processed;
  }
}
