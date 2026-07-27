import { Pool } from 'pg';
import { computeOldestRecentAgeMinutes, isStuck } from './domainEventBacklogMath';

export interface EventBacklogRow {
  event: string;
  pendingTotal: number;
  pendingRecent: number; // pending criados dentro da janela recentWindowHours
  oldestRecentAgeMinutes: number; // idade do pending recente mais antigo (0 se nenhum)
  failedTotal: number;
  stuck: boolean; // oldestRecentAgeMinutes > stuckThresholdMinutes E o evento tem handler
  unhandled: boolean; // true = evento SEM handler registrado (emitido sem consumidor)
}

interface BacklogQueryRow {
  event: string;
  pending_total: number; // int4 — node-pg parses natively to JS number
  pending_recent: number;
  oldest_recent_created_at: Date | null;
  failed_total: number;
}

/**
 * Read-only diagnostic layer for the `domain_events` outbox.
 *
 * Reports backlog + age PER EVENT TYPE so an on-call engineer can pinpoint
 * exactly which pipeline stopped consuming (vs a single aggregate count that
 * hides which event is actually stuck). Zero writes — safe to call on demand
 * or from a scheduled health check.
 */
export class DomainEventBacklogService {
  constructor(private readonly pool: Pool) {}

  /**
   * @param recentWindowHours     janela (horas) que define o que conta como pending "recente"
   * @param stuckThresholdMinutes idade (minutos) acima da qual um grupo é considerado stuck
   * @param handledEvents         eventos com handler registrado. Quando informado,
   *                              só esses podem ficar `stuck` — eventos sem dono
   *                              (emitidos sem consumidor) nunca alarmam, mas
   *                              seguem visíveis com `unhandled: true`. Quando
   *                              `undefined`, todos são avaliados (compat legado).
   */
  async getBacklogSummary(
    recentWindowHours = 6,
    stuckThresholdMinutes = 15,
    handledEvents?: readonly string[],
  ): Promise<EventBacklogRow[]> {
    const { rows } = await this.pool.query<BacklogQueryRow>(
      `
      SELECT
        event,
        COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_total,
        COUNT(*) FILTER (
          WHERE status = 'pending'
            AND created_at > NOW() - (INTERVAL '1 hour' * $1)
        )::int AS pending_recent,
        MIN(created_at) FILTER (
          WHERE status = 'pending'
            AND created_at > NOW() - (INTERVAL '1 hour' * $1)
        ) AS oldest_recent_created_at,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_total
      FROM domain_events
      GROUP BY event
      HAVING COUNT(*) FILTER (WHERE status IN ('pending', 'failed')) > 0
      ORDER BY event
      `,
      [recentWindowHours],
    );

    const now = new Date();
    const handledSet = handledEvents ? new Set(handledEvents) : null;

    return rows.map(row => {
      const oldestRecentAgeMinutes = computeOldestRecentAgeMinutes(
        row.oldest_recent_created_at,
        now,
      );

      // Sem lista de handlers → todos são "handled" (compat legado).
      const unhandled = handledSet ? !handledSet.has(row.event) : false;

      return {
        event: row.event,
        pendingTotal: row.pending_total,
        pendingRecent: row.pending_recent,
        oldestRecentAgeMinutes,
        failedTotal: row.failed_total,
        // Evento sem handler nunca é "stuck" — não há consumidor para drenar;
        // ficaria alarmando para sempre e mascararia um travamento real.
        stuck: !unhandled && isStuck(oldestRecentAgeMinutes, stuckThresholdMinutes),
        unhandled,
      };
    });
  }
}
