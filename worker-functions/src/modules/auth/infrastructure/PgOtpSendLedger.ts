import { createHash } from 'crypto';
import type { Pool } from 'pg';
import type { OtpSendEvent, OtpSendLedgerPort } from '../ports/OtpSendLedgerPort';

/**
 * Registro de envios de OTP (tabela `otp_send_events`, migration 598). `requester_hash` = sha256(uid do token): o uid
 * nunca vai cru ao banco. Sem transação própria. O dia é o dia civil de Buenos Aires (o mesmo da medição do teto).
 */
export class PgOtpSendLedger implements OtpSendLedgerPort {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async sentToday(): Promise<number> {
    const { rows } = await this.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM otp_send_events
        WHERE NOT suppressed
          AND created_at >= (date_trunc('day', NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')
                             AT TIME ZONE 'America/Argentina/Buenos_Aires')`,
    );
    return rows[0].n;
  }

  async findClaimTarget(q: { challengeId: string; requesterUid: string; withinMinutes: number }): Promise<string | null> {
    const { rows } = await this.pool.query<{ worker_id: string | null }>(
      `SELECT COALESCE(e.target_worker_id, c.worker_id) AS worker_id
         FROM otp_send_events e
         LEFT JOIN otp_challenges c ON e.adapter = 'own' AND c.id::text = e.challenge_id
        WHERE e.challenge_id = $1 AND e.requester_hash = $2 AND e.purpose = 'claim'
          AND e.created_at > NOW() - make_interval(mins => $3)
        ORDER BY e.created_at DESC LIMIT 1`,
      [q.challengeId, createHash('sha256').update(q.requesterUid).digest('hex'), q.withinMinutes],
    );
    return rows[0]?.worker_id ?? null;
  }

  async record(event: OtpSendEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO otp_send_events (challenge_id, adapter, purpose, requester_hash, target_worker_id, suppressed)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        event.challengeId,
        event.adapter,
        event.purpose,
        createHash('sha256').update(event.requesterUid).digest('hex'),
        event.targetWorkerId,
        event.suppressed,
      ],
    );
  }
}
