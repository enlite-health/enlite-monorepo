import { Request, Response } from 'express';
import { Pool } from 'pg';
import twilio from 'twilio';
import { TriggerWorkerHandoverUseCase } from '../../application/TriggerWorkerHandoverUseCase';
import { logger } from '@shared/logging';
import { maskPhoneForLog } from '@shared/utils/phoneMask';
import { matchesOptOut, OPT_OUT_BUTTON_PAYLOAD } from '../../domain/optOutMatch';
import { RegisterOptOutUseCase } from '../../application/RegisterOptOutUseCase';
import { ChatwootClient } from '../../infrastructure/ChatwootClient';

/**
 * Controller para mensagens inbound do WhatsApp via Twilio.
 *
 * Recebe POST application/x-www-form-urlencoded quando o worker
 * toca num botão interativo (quick-reply).
 *
 * Opt-out (texto ou botão) e texto livre (handover/espelho) continuam; botões dos fluxos de convite e
 * lembrete de entrevista saíram (spec 052) e são ignorados. Sempre responde 200 para evitar retentativas do Twilio.
 */
export class InboundWhatsAppController {
  /** Cache: contentSid → array de { id, title } dos botões quick-reply */
  private readonly contentActionsCache = new Map<string, { id: string; title: string }[]>();

  constructor(
    private readonly db: Pool,
    /**
     * Opcional: quando ausente OU PERISKOPE_HANDOVER_ENABLED != 'true', o
     * comportamento de texto-livre não-roteável fica idêntico ao atual
     * (apenas log "Message ignored") — flag default OFF, sem impacto em prod.
     */
    private readonly triggerHandoverUseCase?: TriggerWorkerHandoverUseCase,
    /**
     * Opcional: espelho do inbound pro Chatwoot (faz a Luz VER a resposta e
     * responder). Só age quando CHATWOOT_INBOUND_MIRROR_ENABLED='true' E o client
     * foi injetado — flag separada do espelho de outbound, então deploy é neutro.
     */
    private readonly chatwootMirror?: ChatwootClient,
  ) {}

  async handleInbound(req: Request, res: Response): Promise<void> {
    // 1. Validar assinatura Twilio
    if (!this.validateTwilioSignature(req)) {
      res.status(403).json({ error: 'Invalid signature' });
      return;
    }

    const body = req.body as Record<string, string>;
    const from = body['From'] ?? '';
    let buttonPayload = body['ButtonPayload'] ?? '';
    const originalMessageSid = body['OriginalRepliedMessageSid'] ?? '';

    // Opt-out por TEXTO: interceptar intenção de baixa antes de qualquer roteamento.
    // matchesOptOut cobre frase ("quiero darme de baja") e termos es-AR (baja, salir,
    // no me escriban…), não só match exato de palavra única (fix incidente 2026-07-10).
    const bodyTextRaw = (body['Body'] ?? '').trim();
    if (bodyTextRaw && matchesOptOut(bodyTextRaw)) {
      await this.handleOptOut(from, bodyTextRaw);
      res.status(200).send();
      return;
    }

    // Opt-out por BOTÃO: quando o template ganhar o quick-reply "No recibir más"
    // (payload OPT_OUT_BUTTON_PAYLOAD), tratar como baixa independente do fluxo.
    if (buttonPayload === OPT_OUT_BUTTON_PAYLOAD) {
      await this.handleOptOut(from, `button:${buttonPayload}`);
      res.status(200).send();
      return;
    }

    // Fallback: se ButtonPayload vazio, tentar inferir a partir do Body
    // usando o template original (via Twilio Content API) para mapear
    // título do botão → id do botão. Funciona para qualquer template.
    if (!buttonPayload) {
      const bodyText = (body['Body'] ?? '').trim();
      buttonPayload = await this.inferButtonPayloadFromBody(bodyText, originalMessageSid);

      // O botão inferido também pode ser o de opt-out (título → payload 'optout').
      if (buttonPayload === OPT_OUT_BUTTON_PAYLOAD) {
        await this.handleOptOut(from, `button:${buttonPayload}`);
        res.status(200).send();
        return;
      }
    }

    // Texto livre (sem ButtonPayload)
    if (!buttonPayload) {
      const bodyText = (body['Body'] ?? '').trim();
      if (bodyText) {
        // Texto livre não-roteável: gatilho de handover Twilio → Periskope
        // (item de fundação do roteamento por worker). Flag default OFF.
        await this.maybeTriggerHandover(from);
        // Espelha a resposta livre pro Chatwoot como `incoming` → a Luz VÊ e responde
        // (o elo que faltava; hoje esse texto morria aqui). Gated por
        // CHATWOOT_INBOUND_MIRROR_ENABLED — deploy neutro até o go-live.
        await this.maybeMirrorIncomingToChatwoot(from, bodyText, body);
      }
      console.info('[InboundWhatsApp] Message ignored (no ButtonPayload)', { from });
      res.status(200).send();
      return;
    }

    // Botão de convite/lembrete de entrevista antigo: o fluxo automático saiu (spec 052) — ignorado, sempre 200.
    console.info('[InboundWhatsApp] Message ignored (button of removed interview flow)', { from: maskPhoneForLog(from), buttonPayload });

    // 4. Twilio espera 200 OK
    res.status(200).send();
  }

  /**
   * Registra opt-out do worker. Delega ao RegisterOptOutUseCase — a fonte única
   * de escrita (mesma usada pela Luz via MCP e pelo Periskope). Normaliza phone
   * e faz ON CONFLICT = re-opt-out lá dentro.
   */
  private async handleOptOut(from: string, keyword: string): Promise<void> {
    const phone = from.replace('whatsapp:', '');
    const log = logger.child({ phone: maskPhoneForLog(phone), keyword, handler: 'OptOut' });

    try {
      const result = await new RegisterOptOutUseCase(this.db).execute({
        phone: from,
        source: 'whatsapp_inbound',
      });

      if (!result.ok) {
        log.info('Opt-out request from unknown phone, ignoring');
        return;
      }

      log.info({ workerId: result.workerId }, 'Worker opted out of WhatsApp messages');
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      log.error({ error: e.message }, 'Failed to process opt-out');
    }
  }

  /**
   * Gatilho de handover Twilio → Periskope: quando o texto livre não foi
   * capturado por nenhum fluxo conhecido (tryHandleTextResponse retornou
   * false), este é o 1º texto livre não-roteável do worker no canal Twilio.
   *
   * No-op (sem query, sem side-effect) quando PERISKOPE_HANDOVER_ENABLED !=
   * 'true' ou quando triggerHandoverUseCase não foi injetado — flag default
   * OFF preserva o comportamento atual de produção sem as envs novas.
   */
  private async maybeTriggerHandover(from: string): Promise<void> {
    if (process.env.PERISKOPE_HANDOVER_ENABLED !== 'true' || !this.triggerHandoverUseCase) {
      return;
    }

    const phone = from.replace('whatsapp:', '');

    try {
      const workerRes = await this.db.query<{ id: string; messaging_channel: string }>(
        `SELECT id, messaging_channel FROM workers WHERE phone = $1 LIMIT 1`,
        [phone],
      );
      const worker = workerRes.rows[0];
      if (!worker || worker.messaging_channel !== 'twilio') return;

      const result = await this.triggerHandoverUseCase.execute(worker.id, phone);
      if (result.isFailure) {
        console.warn('[InboundWhatsApp] Handover failed:', result.error);
      }
    } catch (err) {
      console.warn('[InboundWhatsApp] maybeTriggerHandover error:', err);
    }
  }

  /**
   * Espelha a resposta livre do worker pro Chatwoot como mensagem `incoming`, o que
   * faz o Chatwoot disparar o webhook → a Luz (triage-service) processar e responder.
   * É o elo que liga a resposta do convite (que hoje morre neste controller) ao motor
   * reativo da Luz. Best-effort: nunca lança. Gated por CHATWOOT_INBOUND_MIRROR_ENABLED
   * (flag separada do espelho de outbound) — deploy neutro até o go-live.
   */
  private async maybeMirrorIncomingToChatwoot(
    from: string,
    content: string,
    body: Record<string, string>,
  ): Promise<void> {
    if (process.env.CHATWOOT_INBOUND_MIRROR_ENABLED !== 'true' || !this.chatwootMirror) return;
    const phone = from.replace('whatsapp:', '');
    // MessageSid do inbound = source_id do Chatwoot (dedup/idempotência).
    const externalId = body['MessageSid'] || body['SmsSid'] || body['SmsMessageSid'] || '';
    if (!externalId) return;
    try {
      await this.chatwootMirror.mirrorIncomingMessage({ phone, content, externalId });
    } catch (err) {
      console.warn('[InboundWhatsApp] maybeMirrorIncomingToChatwoot error:', err);
    }
  }

  /**
   * Infere o ButtonPayload a partir do texto do Body consultando o template
   * original via Twilio Content API.
   *
   * Fluxo:
   *   1. OriginalRepliedMessageSid → messaging_outbox.template_slug
   *   2. template_slug → message_templates.content_sid
   *   3. content_sid → Twilio Content API → actions[].title
   *   4. Body text match contra titles → retorna action.id
   *
   * Funciona para qualquer template com qualquer texto de botão.
   */
  private async inferButtonPayloadFromBody(
    bodyText: string,
    originalMessageSid: string,
  ): Promise<string> {
    if (!bodyText || !originalMessageSid) return '';

    try {
      // 1. Template slug da mensagem original
      const outboxResult = await this.db.query<{ template_slug: string }>(
        `SELECT template_slug FROM messaging_outbox WHERE twilio_sid = $1 LIMIT 1`,
        [originalMessageSid],
      );
      const slug = outboxResult.rows[0]?.template_slug;
      if (!slug) return '';

      // 2. Content SID do template
      const templateResult = await this.db.query<{ content_sid: string | null }>(
        `SELECT content_sid FROM message_templates WHERE slug = $1 AND is_active = true LIMIT 1`,
        [slug],
      );
      const contentSid = templateResult.rows[0]?.content_sid;
      if (!contentSid) return '';

      // 3. Buscar ações do template (cache in-memory)
      const actions = await this.getContentActions(contentSid);

      // 4. Match case-insensitive do Body contra títulos dos botões
      const normalized = bodyText.toLowerCase();
      const match = actions.find(a => a.title.toLowerCase() === normalized);

      if (match) {
        console.info('[InboundWhatsApp] Inferred ButtonPayload from Body via Content API', {
          bodyText, contentSid, buttonPayload: match.id,
        });
        return match.id;
      }
    } catch (err) {
      console.warn('[InboundWhatsApp] inferButtonPayloadFromBody error:', err);
    }

    return '';
  }

  /**
   * Busca as ações quick-reply de um Content Template no Twilio Content API.
   * Resultado é cacheado em memória (templates raramente mudam).
   */
  private async getContentActions(contentSid: string): Promise<{ id: string; title: string }[]> {
    const cached = this.contentActionsCache.get(contentSid);
    if (cached) return cached;

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!accountSid || !authToken) return [];

    const response = await fetch(
      `https://content.twilio.com/v1/Content/${contentSid}`,
      {
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        },
      },
    );

    if (!response.ok) {
      console.warn(`[InboundWhatsApp] Content API fetch failed: ${response.status} for ${contentSid}`);
      return [];
    }

    const data = (await response.json()) as Record<string, unknown>;
    const types = data.types as Record<string, { actions?: { id: string; title: string }[] }> | undefined;
    const quickReply = types?.['twilio/quick-reply'];
    const actions = quickReply?.actions ?? [];

    this.contentActionsCache.set(contentSid, actions);
    return actions;
  }

  /**
   * Valida X-Twilio-Signature (HMAC).
   * Se TWILIO_INBOUND_WEBHOOK_URL não configurado, pula validação (dev/test).
   * Requests via Studio Flow (JSON) chegam sem X-Twilio-Signature — aceitos
   * porque o Studio Flow é interno ao Twilio e já autenticou a mensagem original.
   */
  private validateTwilioSignature(req: Request): boolean {
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const webhookUrl = process.env.TWILIO_INBOUND_WEBHOOK_URL;

    if (!webhookUrl || !authToken) {
      console.warn('[InboundWhatsApp] TWILIO_INBOUND_WEBHOOK_URL not set — signature validation skipped');
      return true;
    }

    const signature = req.headers['x-twilio-signature'] as string | undefined;

    // Validação HMAC padrão (requests diretos do Twilio)
    if (signature) {
      const valid = twilio.validateRequest(
        authToken,
        signature,
        webhookUrl,
        req.body as Record<string, string>,
      );
      if (valid) return true;
    }

    // Fallback: Studio Flow pode enviar X-Twilio-Signature assinado contra a URL
    // do Flow (não a do webhook), fazendo a validação HMAC falhar.
    // Aceitar se AccountSid no body corresponde ao nosso.
    const bodySid = (req.body as Record<string, string>)?.['AccountSid'];
    if (bodySid && bodySid === process.env.TWILIO_ACCOUNT_SID) {
      return true;
    }

    return false;
  }
}
