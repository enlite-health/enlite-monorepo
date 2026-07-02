import { Request, Response } from 'express';
import { Pool } from 'pg';
import { createHmac, timingSafeEqual } from 'crypto';
import { HandleReminderResponseUseCase } from '../../application/HandleReminderResponseUseCase';
import { logger } from '@shared/logging';

const OPT_OUT_KEYWORDS = new Set([
  'parar', 'stop', 'cancelar', 'desuscribir', 'desuscribirme',
  'no quiero', 'basta', 'unsubscribe', 'optout', 'opt-out',
]);

/** Envelope de todo webhook do Periskope. */
interface PeriskopeWebhookEnvelope {
  event: string;
  data: PeriskopeMessageData;
  org_id: string;
  timestamp: string;
}

/** Campos do Message Object que este controller consome (message.created). */
interface PeriskopeMessageData {
  message_id?: string;
  chat_id?: string;
  body?: string;
  message_type?: string;
  from_me?: boolean;
}

/**
 * Controller para eventos inbound do Periskope (webhook message.created).
 *
 * Substitui, no provider Periskope, o papel que o Studio Flow + Twilio
 * ButtonPayload cumprem no canal WABA. Como o WhatsApp Web não tem botões
 * interativos, todo inbound é texto livre:
 *   1. opt-out (PARAR/STOP/...) → messaging_opt_out
 *   2. worker em awaiting_reason → captura motivo de recusa (RECHAZADO)
 *   3. resto: ignorado com log (a inbox humana é o próprio Periskope; a
 *      triagem IA consome o mesmo webhook em serviço separado)
 *
 * O roteamento de respostas numeradas aos fluxos de convite/reminder
 * (equivalente ao ButtonPayload) entra na fase 2.3 da migração, após o piloto
 * validar poll vs texto — ver docs/roadmaps/ROADMAP-PERISKOPE.md do chatbot.
 *
 * Sempre responde 200 para evitar retentativas do Periskope; a exceção é
 * assinatura inválida (403).
 */
export class PeriskopeWebhookController {
  constructor(
    private readonly db: Pool,
    private readonly handleReminderResponseUseCase: HandleReminderResponseUseCase,
  ) {}

  async handleWebhook(req: Request, res: Response): Promise<void> {
    if (!this.validateSignature(req)) {
      res.status(403).json({ error: 'Invalid signature' });
      return;
    }

    const envelope = req.body as Partial<PeriskopeWebhookEnvelope>;

    if (envelope.event !== 'message.created') {
      // Outros eventos (acks, tickets, phone status) não são deste fluxo.
      res.status(200).send();
      return;
    }

    const data = envelope.data ?? {};

    // Mensagens enviadas por nós (ou pela agente na inbox) também disparam
    // message.created — from_me distingue.
    if (data.from_me) {
      res.status(200).send();
      return;
    }

    const from = this.phoneFromChatId(data.chat_id ?? '');
    if (!from) {
      // Grupos (@g.us) e chat_ids não reconhecidos ficam fora deste fluxo.
      console.info('[PeriskopeInbound] Message ignored (no 1-1 chat_id)', { chatId: data.chat_id });
      res.status(200).send();
      return;
    }

    const bodyText = (data.body ?? '').trim();

    try {
      if (bodyText && OPT_OUT_KEYWORDS.has(bodyText.toLowerCase())) {
        await this.handleOptOut(from, bodyText);
      } else if (bodyText) {
        const handled = await this.tryHandleTextResponse(from, bodyText);
        if (!handled) {
          console.info('[PeriskopeInbound] Message ignored (no special state)', { from });
        }
      }
    } catch (err) {
      console.error('[PeriskopeInbound] Unexpected error:', err);
    }

    res.status(200).send();
  }

  /**
   * Valida x-periskope-signature: HMAC-SHA256 (hex) do raw body com a signing
   * key gerada no console do Periskope ao criar o webhook.
   * Se PERISKOPE_WEBHOOK_SECRET não configurado, pula validação (dev/test).
   */
  private validateSignature(req: Request): boolean {
    const secret = process.env.PERISKOPE_WEBHOOK_SECRET;
    if (!secret) {
      console.warn('[PeriskopeInbound] PERISKOPE_WEBHOOK_SECRET not set — signature validation skipped');
      return true;
    }

    const signature = req.headers['x-periskope-signature'];
    if (typeof signature !== 'string' || !signature) return false;

    // rawBody é capturado no express.json({ verify }) do composition root para
    // as rotas /webhooks*/periskope — HMAC sobre body re-serializado não é
    // confiável (ordem de chaves/whitespace).
    const raw = (req as Request & { rawBody?: string }).rawBody
      ?? JSON.stringify(req.body ?? {});

    const expected = createHmac('sha256', secret).update(raw).digest('hex');

    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length) return false;
    return timingSafeEqual(sigBuf, expBuf);
  }

  /** chat_id 1-1 do Periskope: <DDI+numero>@c.us → +E.164. Grupos (@g.us) retornam null. */
  private phoneFromChatId(chatId: string): string | null {
    const match = /^(\d+)@c\.us$/.exec(chatId);
    return match ? `+${match[1]}` : null;
  }

  /**
   * Registra opt-out do worker em messaging_opt_out (ON CONFLICT = re-opt-out).
   * Mesma semântica do canal Twilio — a tabela é compartilhada entre providers.
   */
  private async handleOptOut(phone: string, keyword: string): Promise<void> {
    const log = logger.child({ phone, keyword, handler: 'PeriskopeOptOut' });

    try {
      const workerRes = await this.db.query<{ id: string }>(
        `SELECT id FROM workers WHERE phone = $1 LIMIT 1`,
        [phone],
      );

      if (workerRes.rows.length === 0) {
        log.info('Opt-out request from unknown phone, ignoring');
        return;
      }

      const workerId = workerRes.rows[0].id;

      await this.db.query(
        `INSERT INTO messaging_opt_out (worker_id, phone, reason, source)
         VALUES ($1, $2, 'user_request', 'whatsapp_inbound')
         ON CONFLICT (worker_id)
         DO UPDATE SET opted_out_at = NOW(), opted_in_at = NULL, reason = 'user_request'`,
        [workerId, phone],
      );

      log.info({ workerId }, 'Worker opted out of WhatsApp messages');
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      log.error({ error: e.message }, 'Failed to process opt-out');
    }
  }

  /**
   * Verifica se o worker está em estado awaiting_reason e processa texto livre.
   * Retorna true se o texto foi capturado como motivo de recusa.
   */
  private async tryHandleTextResponse(from: string, bodyText: string): Promise<boolean> {
    try {
      const result = await this.handleReminderResponseUseCase.executeTextResponse(from, bodyText);
      if (result.isSuccess) {
        console.info('[PeriskopeInbound] Free text captured as decline reason', { from });
        return true;
      }
      return false;
    } catch (err) {
      console.warn('[PeriskopeInbound] tryHandleTextResponse error:', err);
      return false;
    }
  }
}
