/**
 * accountLinkEvents — telemetria durável do funil de vínculo + rate-limit.
 *
 * Cada passo grava uma linha em account_link_events (migration 259). O
 * rate-limit de start (3/h por conta) é um COUNT na própria tabela: durável
 * e correto com múltiplas instâncias do Cloud Run (contador em memória não é).
 */

import type { Pool } from 'pg';
import { logger } from '@shared/logging';

export type AccountLinkEvent =
  | 'lookup'
  | 'started'
  | 'confirmed'
  | 'conflicts_shown'
  | 'merged'
  | 'requires_review'
  | 'undone'
  | 'notice_email_sent'
  | 'notice_email_skipped';

export const START_RATE_LIMIT_PER_HOUR = 3;

const log = () => logger.child({ source: 'accountLinkEvents' });

export async function recordAccountLinkEvent(
  pool: Pool,
  params: {
    event: AccountLinkEvent;
    workerId?: string | null;
    otherWorkerId?: string | null;
    mergeAuditId?: number | null;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  const { event, workerId, otherWorkerId, mergeAuditId, detail } = params;
  try {
    await pool.query(
      `INSERT INTO account_link_events (event, worker_id, other_worker_id, merge_audit_id, detail)
       VALUES ($1, $2::uuid, $3::uuid, $4, $5::jsonb)`,
      [event, workerId ?? null, otherWorkerId ?? null, mergeAuditId ?? null, JSON.stringify(detail ?? {})],
    );
  } catch (err) {
    // Telemetria nunca derruba o fluxo — mas rate-limit depende dela, então loga alto.
    const e = err instanceof Error ? err : new Error(String(err));
    log().error({ msg: 'account_link_event_insert_failed', event, reason: e.message });
  }
  // Espelho no Cloud Logging (métrica/alerta sem query no banco)
  log().info({
    msg: `account_link_${event}`,
    workerId: workerId ?? null,
    otherWorkerId: otherWorkerId ?? null,
    mergeAuditId: mergeAuditId ?? null,
    ...(detail ?? {}),
  });
}

/** true quando a conta ainda PODE iniciar (menos de 3 starts na última hora). */
export async function canStartWithinRateLimit(pool: Pool, workerId: string): Promise<boolean> {
  const res = await pool.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM account_link_events
     WHERE worker_id = $1::uuid AND event = 'started'
       AND created_at > NOW() - INTERVAL '1 hour'`,
    [workerId],
  );
  return Number(res.rows[0]?.cnt ?? 0) < START_RATE_LIMIT_PER_HOUR;
}
