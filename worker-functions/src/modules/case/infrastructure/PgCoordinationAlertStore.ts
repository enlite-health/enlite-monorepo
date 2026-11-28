/**
 * PgCoordinationAlertStore — `coordination_alert` e `coordination_alert_delivery` (migration 597, emenda 077 §5.3). Só `app_system`.
 * A UNIQUE (kind, occurrence_id) é a idempotência por turno: `insertAlertIfAbsent` usa `ON CONFLICT DO NOTHING` e devolve `null` na 2ª vez.
 * Entrega de e-mail: `claimDelivery` (UPDATE atômico PENDING → SENDING) e `markDelivery` (resultado). Sem PII além do uid do destinatário.
 */
import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import type { AlertTransaction, CoordinationAlertKind, CoordinationAlertStore, DeliveryChannelCode, DeliveryOutcome, DeliveryStatus } from '../application/ports/CoordinationAlertPorts';

/** Um `SENDING` mais velho que isto é de uma execução que morreu (molde do "Sin cubrir"). */
export const CLAIM_STALE_MINUTES = 15;

export async function insertAlertIfAbsent(client: PoolClient, kind: CoordinationAlertKind, occurrenceId: string): Promise<string | null> {
  const res = await client.query<{ alert_id: string }>(
    `INSERT INTO coordination_alert (kind, occurrence_id) VALUES ($1, $2)
     ON CONFLICT (kind, occurrence_id) DO NOTHING
     RETURNING alert_id`,
    [kind, occurrenceId],
  );
  return res.rows[0]?.alert_id ?? null;
}

export async function recordDelivery(
  client: PoolClient,
  row: { alertId: string; recipientUid: string; channel: DeliveryChannelCode; status: DeliveryStatus; errorCode?: string; notificationEventId?: string },
): Promise<void> {
  await client.query(
    `INSERT INTO coordination_alert_delivery (alert_id, recipient_uid, channel, status, error_code, notification_event_id) VALUES ($1, $2, $3, $4, $5, $6)`,
    [row.alertId, row.recipientUid, row.channel, row.status, row.errorCode ?? null, row.notificationEventId ?? null],
  );
}

export class PgCoordinationAlertStore implements CoordinationAlertStore {
  private poolMemo?: Pool;

  constructor(pool?: Pool) {
    this.poolMemo = pool;
  }

  private get pool(): Pool {
    this.poolMemo ??= DatabaseConnection.getInstance().getPool();
    return this.poolMemo;
  }

  inTransaction<T>(work: (tx: AlertTransaction) => Promise<T>): Promise<T> {
    return withActorContext(this.pool, (client) =>
      work({
        handle: client,
        insertAlertIfAbsent: (kind, occurrenceId) => insertAlertIfAbsent(client, kind, occurrenceId),
        recordDelivery: (row) => recordDelivery(client, row),
      }),
    );
  }

  async claimDelivery(alertId: string, recipientUid: string, channel: DeliveryChannelCode): Promise<boolean> {
    const res = await withActorContext(this.pool, (client) =>
      client.query(
        `UPDATE coordination_alert_delivery
            SET status = 'SENDING', error_code = NULL, updated_at = now()
          WHERE alert_id = $1 AND recipient_uid = $2 AND channel = $3
            AND (status IN ('PENDING','FAILED') OR (status = 'SENDING' AND updated_at < now() - make_interval(mins => $4::int)))
        RETURNING 1`,
        [alertId, recipientUid, channel, CLAIM_STALE_MINUTES],
      ),
    );
    return (res.rowCount ?? 0) > 0;
  }

  async markDelivery(alertId: string, recipientUid: string, channel: DeliveryChannelCode, outcome: DeliveryOutcome): Promise<void> {
    await withActorContext(this.pool, (client) =>
      client.query(
        `UPDATE coordination_alert_delivery SET status = $4, error_code = $5, updated_at = now() WHERE alert_id = $1 AND recipient_uid = $2 AND channel = $3`,
        [alertId, recipientUid, channel, outcome.status, outcome.errorCode ?? null],
      ),
    );
  }
}
