/**
 * UncoveredAlertDispatchRepository — o despacho do alerta diário a um destinatário (spec 069 F4, tabela
 * `itinerary_uncovered_alert_dispatch`, migration 548). A PK `(operation_date, recipient_uid)` é a IDEMPOTÊNCIA: `insertPending`
 * roda na MESMA transação que grava evento + notificação; a 2ª tentativa do dia viola a PK (23505) e a transação inteira volta.
 * `email_status` é o único dono do resultado do e-mail ('SENDING' = reivindicado por UMA execução, migration 549). Só `app_system`. Sem PII além do uid.
 */
import type { PoolClient } from 'pg';

export type AlertEmailStatus = 'PENDING' | 'SENDING' | 'SENT' | 'FAILED' | 'SKIPPED_TEST' | 'SKIPPED_NO_KEY' | 'NO_ADDRESS';

/** `true` = violação da PK do despacho (já enviado hoje). */
export function isAlreadyDispatched(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505';
}

/** Dias (contando o do `operationDate`) em que o e-mail pendente/falho ainda é retomado. */
export const RETRY_WINDOW_DAYS = 3;
/** Um `SENDING` mais velho que isto é de uma execução que morreu: volta a ser reivindicável. */
export const CLAIM_STALE_MINUTES = 15;

export interface RetryableDispatch {
  operationDate: string;
  recipientUid: string;
}

export class UncoveredAlertDispatchRepository {
  async insertPending(client: PoolClient, input: { operationDate: string; recipientUid: string; eventId: string }): Promise<void> {
    await client.query(
      `INSERT INTO itinerary_uncovered_alert_dispatch (operation_date, recipient_uid, event_id, email_status) VALUES ($1::date, $2, $3, 'PENDING')`,
      [input.operationDate, input.recipientUid, input.eventId],
    );
  }

  /**
   * Despachos cujo e-mail ainda precisa de tentativa: `PENDING` (commit da in-app sem e-mail), `FAILED` e `SENDING` abandonado
   * (reivindicado há mais de `CLAIM_STALE_MINUTES` — a execução morreu antes de marcar). JANELA de `RETRY_WINDOW_DAYS` dias até
   * `operationDate` (D2b da QA caça): antes só o dia corrente era olhado, então um e-mail que falhasse às 23:59 nunca era retomado
   * no dia seguinte. SÓ a linha MAIS NOVA de cada destinatário: o payload do e-mail é montado com a cobertura de AGORA (não um retrato do
   * dia do despacho), então uma linha antiga com outra mais nova atrás (já enviada ou a ser retomada) reenviaria o MESMO aviso — fica
   * superada e envelhece até sair da janela. Resultado: no máximo UMA linha por destinatário.
   */
  async listRetryable(client: PoolClient, operationDate: string): Promise<RetryableDispatch[]> {
    const res = await client.query<{ operation_date: string; recipient_uid: string }>(
      `SELECT to_char(d.operation_date, 'YYYY-MM-DD') AS operation_date, d.recipient_uid
         FROM itinerary_uncovered_alert_dispatch d
        WHERE d.operation_date BETWEEN ($1::date - $2::int) AND $1::date
          AND (d.email_status IN ('PENDING','FAILED') OR (d.email_status = 'SENDING' AND d.updated_at < now() - make_interval(mins => $3::int)))
          AND NOT EXISTS (
            SELECT 1 FROM itinerary_uncovered_alert_dispatch n
             WHERE n.recipient_uid = d.recipient_uid AND n.operation_date > d.operation_date AND n.operation_date <= $1::date)
        ORDER BY d.operation_date, d.recipient_uid`,
      [operationDate, RETRY_WINDOW_DAYS - 1, CLAIM_STALE_MINUTES],
    );
    return res.rows.map((r) => ({ operationDate: r.operation_date, recipientUid: r.recipient_uid }));
  }

  /**
   * D2c: REIVINDICA a linha antes de enviar — um UPDATE atômico `PENDING|FAILED|SENDING-velho → SENDING … RETURNING`. Só quem recebeu
   * a linha de volta (`true`) envia; a execução concorrente que perdeu a corrida recebe `false` e NÃO manda o 2º e-mail. Zera o
   * `email_error_code` (a CHECK `iuad_error_pair` só admite código em `FAILED`).
   */
  async claimEmail(client: PoolClient, input: { operationDate: string; recipientUid: string }): Promise<boolean> {
    const res = await client.query(
      `UPDATE itinerary_uncovered_alert_dispatch
          SET email_status = 'SENDING', email_error_code = NULL, updated_at = now()
        WHERE operation_date = $1::date AND recipient_uid = $2
          AND (email_status IN ('PENDING','FAILED') OR (email_status = 'SENDING' AND updated_at < now() - make_interval(mins => $3::int)))
        RETURNING 1`,
      [input.operationDate, input.recipientUid, CLAIM_STALE_MINUTES],
    );
    return (res.rowCount ?? 0) > 0;
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
