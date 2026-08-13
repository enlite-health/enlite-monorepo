import { Request, Response } from 'express';
import twilio from 'twilio';
import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';

/**
 * Controller que recebe status callbacks do Twilio.
 *
 * O Twilio envia POST application/x-www-form-urlencoded quando o status
 * de uma mensagem WhatsApp muda (queued → sent → delivered / failed).
 *
 * Sem autenticação Firebase — validado via X-Twilio-Signature.
 * Sempre responde 200 para evitar retentativas do Twilio em caso de erro de DB.
 */
export class TwilioWebhookController {
  private db: Pool;

  constructor() {
    this.db = DatabaseConnection.getInstance().getPool();
  }

  async handleStatusCallback(req: Request, res: Response): Promise<void> {
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const callbackUrl = process.env.TWILIO_STATUS_CALLBACK_URL;

    // Valida assinatura Twilio para garantir autenticidade do callback.
    // Se TWILIO_STATUS_CALLBACK_URL não estiver configurado, pular validação.
    if (callbackUrl && authToken) {
      const signature = req.headers['x-twilio-signature'] as string | undefined;

      if (!signature) {
        console.warn('[TwilioWebhook] Requisição sem X-Twilio-Signature — rejeitada');
        res.status(403).end();
        return;
      }

      const isValid = twilio.validateRequest(authToken, signature, callbackUrl, req.body as Record<string, string>);

      if (!isValid) {
        console.warn('[TwilioWebhook] Assinatura inválida — rejeitada');
        res.status(403).end();
        return;
      }
    } else {
      console.warn('[TwilioWebhook] TWILIO_STATUS_CALLBACK_URL não configurado — validação de assinatura ignorada');
    }

    const body = req.body as Record<string, string>;
    const messageSid = body['MessageSid'];
    const messageStatus = body['MessageStatus'];
    // ErrorCode vem no callback quando falha (ex: 63024 bloqueio, 63005 não-WhatsApp).
    // Antes era descartado — agora persistido pra distinguir bloqueio de nº inválido.
    const errorCode = body['ErrorCode'] || null;

    if (!messageSid || !messageStatus) {
      console.warn('[TwilioWebhook] Payload inválido: MessageSid ou MessageStatus ausente');
      res.status(200).end();
      return;
    }

    console.log(`[TwilioWebhook] SID=${messageSid} status=${messageStatus}${errorCode ? ` err=${errorCode}` : ''}`);

    try {
      await this.db.query(
        `UPDATE whatsapp_bulk_dispatch_logs
         SET delivery_status = $1,
             error_message = COALESCE($3, error_message)
         WHERE twilio_sid = $2`,
        [messageStatus, messageSid, errorCode],
      );
    } catch (err) {
      console.error('[TwilioWebhook] Erro ao atualizar whatsapp_bulk_dispatch_logs:', err);
    }

    try {
      await this.db.query(
        `UPDATE messaging_outbox
         SET delivery_status = $1
         WHERE twilio_sid = $2`,
        [messageStatus, messageSid],
      );
    } catch (err) {
      console.error('[TwilioWebhook] Erro ao atualizar messaging_outbox:', err);
    }

    // AUTO-BLOQUEIO (incidente 2026-07-10, parte "FUTURO"): quando um envio falha
    // (undelivered/failed), se o worker já acumulou >=2 falhas, entra na lista de
    // supressão (a MESMA que o guard do OutboxProcessor enforce). Self-healing:
    // número morto/bloqueado nunca mais é tentado. Mesmo critério do backfill (245).
    if (messageStatus === 'undelivered' || messageStatus === 'failed') {
      await this.maybeSuppressOnRepeatedFailure(messageSid);
    }

    // Twilio não usa o body da resposta — apenas o status code importa.
    res.status(200).end();
  }

  /**
   * Suprime o worker se ele já tem >=2 mensagens undelivered/failed. Best-effort:
   * qualquer erro é logado e engolido (não pode quebrar o 200 pro Twilio).
   * ON CONFLICT DO NOTHING = não sobrescreve opt-out por outro motivo (ex: user_request).
   */
  private async maybeSuppressOnRepeatedFailure(messageSid: string): Promise<void> {
    try {
      const res = await this.db.query<{ worker_id: string; phone: string | null; fails: string }>(
        `SELECT l.worker_id, l.phone,
                (SELECT COUNT(*) FROM whatsapp_bulk_dispatch_logs l2
                  WHERE l2.worker_id = l.worker_id
                    AND l2.delivery_status IN ('undelivered','failed')) AS fails
         FROM whatsapp_bulk_dispatch_logs l
         WHERE l.twilio_sid = $1
         LIMIT 1`,
        [messageSid],
      );
      const row = res.rows[0];
      if (!row || !row.worker_id || !row.phone) return;
      if (parseInt(row.fails, 10) < 2) return;

      await this.db.query(
        `INSERT INTO messaging_opt_out (worker_id, phone, reason, source)
         VALUES ($1, $2, 'undelivered_cap', 'twilio_status_auto')
         ON CONFLICT (worker_id) DO NOTHING`,
        [row.worker_id, row.phone],
      );
      console.log(`[TwilioWebhook] worker ${row.worker_id} suprimido (>=2 falhas de entrega)`);
    } catch (err) {
      console.error('[TwilioWebhook] Erro no auto-bloqueio por falha repetida:', err);
    }
  }
}
