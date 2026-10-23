/**
 * UncoveredAlertDispatchRepository — o despacho do alerta diário a um destinatário (spec 069 F4, tabela
 * `itinerary_uncovered_alert_dispatch`, migration 548). A PK `(operation_date, recipient_uid)` é a IDEMPOTÊNCIA: `insertPending`
 * roda na MESMA transação que grava evento + notificação; a 2ª tentativa do dia viola a PK (23505) e a transação inteira volta.
 * `email_status` é o único dono do resultado do e-mail. Só `app_system`. Sem PII além do uid.
 */
import type { PoolClient } from 'pg';

export type AlertEmailStatus = 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED_TEST' | 'SKIPPED_NO_KEY' | 'NO_ADDRESS';

/** `true` = violação da PK do despacho (já enviado hoje). */
export function isAlreadyDispatched(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505';
}

export class UncoveredAlertDispatchRepository {
  async insertPending(client: PoolClient, input: { operationDate: string; recipientUid: string; eventId: string }): Promise<void> {
    await client.query(
      `INSERT INTO itinerary_uncovered_alert_dispatch (operation_date, recipient_uid, event_id, email_status) VALUES ($1::date, $2, $3, 'PENDING')`,
      [input.operationDate, input.recipientUid, input.eventId],
    );
  }

  /** Destinatários do dia cujo e-mail ainda precisa de tentativa: `PENDING` (commit da in-app sem e-mail) e `FAILED`. */
  async listRetryable(client: PoolClient, operationDate: string): Promise<string[]> {
    const res = await client.query<{ recipient_uid: string }>(
      `SELECT recipient_uid FROM itinerary_uncovered_alert_dispatch WHERE operation_date = $1::date AND email_status IN ('PENDING','FAILED')`,
      [operationDate],
    );
    return res.rows.map((r) => r.recipient_uid);
  }

  async markEmail(
    client: PoolClient,
    input: { operationDate: string; recipientUid: string; status: AlertEmailStatus; errorCode: string | null },
  ): Promise<void> {
    await client.query(
      `UPDATE itinerary_uncovered_alert_dispatch
          SET email_status = $3, email_error_code = $4, updated_at = now()
        WHERE operation_date = $1::date AND recipient_uid = $2`,
      [input.operationDate, input.recipientUid, input.status, input.errorCode],
    );
  }
}
