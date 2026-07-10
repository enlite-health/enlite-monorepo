import { Request, Response } from 'express';
import { Pool } from 'pg';
import twilio from 'twilio';
import { BookSlotFromWhatsAppUseCase } from '../../application/BookSlotFromWhatsAppUseCase';
import { HandleReminderResponseUseCase } from '../../application/HandleReminderResponseUseCase';
import { TriggerWorkerHandoverUseCase } from '../../application/TriggerWorkerHandoverUseCase';
import { logger } from '@shared/logging';
import {
  INTERVIEW_INVITE_SLUG,
  LEGACY_INVITE_SLUG,
  REMINDER_CONFIRM_SLUG,
  REMINDER_RESCHEDULE_SLUG,
  INTERVIEW_SLUGS,
} from '../../domain/interviewFlowTemplateSlugs';
import { matchesOptOut, OPT_OUT_BUTTON_PAYLOAD } from '../../domain/optOutMatch';
import { ChatwootClient } from '../../infrastructure/ChatwootClient';

/**
 * Controller para mensagens inbound do WhatsApp via Twilio.
 *
 * Recebe POST application/x-www-form-urlencoded quando o worker
 * toca num botão interativo (quick-reply).
 *
 * Roteamento em dois passos:
 *   1. OriginalRepliedMessageSid → lookup na messaging_outbox → template_slug
 *   2. template_slug + ButtonPayload determinam o use case correto
 *
 * Se o template_slug não pertence ao fluxo de entrevista, a mensagem é ignorada.
 * Sempre responde 200 para evitar retentativas do Twilio.
 */
export class InboundWhatsAppController {
  /** Cache: contentSid → array de { id, title } dos botões quick-reply */
  private readonly contentActionsCache = new Map<string, { id: string; title: string }[]>();

  constructor(
    private readonly db: Pool,
    private readonly bookSlotUseCase: BookSlotFromWhatsAppUseCase,
    private readonly handleReminderResponseUseCase: HandleReminderResponseUseCase,
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

    // Texto livre: se não tem ButtonPayload, checar se worker está em awaiting_reason
    if (!buttonPayload) {
      const bodyText = (body['Body'] ?? '').trim();
      if (bodyText) {
        const handled = await this.tryHandleTextResponse(from, bodyText);
        if (handled) {
          res.status(200).send();
          return;
        }
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

    // 2. Identificar template_slug via OriginalRepliedMessageSid + rotear
    try {
      let templateSlug: string | null = null;

      if (originalMessageSid) {
        const outboxResult = await this.db.query<{ template_slug: string }>(
          `SELECT template_slug FROM messaging_outbox WHERE twilio_sid = $1 LIMIT 1`,
          [originalMessageSid],
        );
        templateSlug = outboxResult.rows[0]?.template_slug ?? null;
      }

      // 3. Rotear por template_slug + ButtonPayload
      if (templateSlug && !INTERVIEW_SLUGS.has(templateSlug)) {
        // Mensagem de outro fluxo (ex: client_selection) — não é nossa
        console.info('[InboundWhatsApp] Message ignored (template not interview flow)', {
          from, templateSlug, buttonPayload,
        });
      } else if ((templateSlug === INTERVIEW_INVITE_SLUG || templateSlug === LEGACY_INVITE_SLUG) && buttonPayload.startsWith('slot_')) {
        // Resposta ao convite de entrevista: worker escolheu horário
        const result = await this.bookSlotUseCase.execute(from, buttonPayload, originalMessageSid);
        if (result.isFailure) {
          console.warn(`[InboundWhatsApp] BookSlot failed: ${result.error}`);
        }
      } else if (templateSlug === REMINDER_CONFIRM_SLUG && buttonPayload.startsWith('confirm_')) {
        // Resposta ao reminder de 24h: worker confirmou ou declinou
        const result = await this.handleReminderResponseUseCase.execute(from, buttonPayload, originalMessageSid);
        if (result.isFailure) {
          console.warn(`[InboundWhatsApp] ReminderResponse failed: ${result.error}`);
        }
      } else if (templateSlug === REMINDER_RESCHEDULE_SLUG && buttonPayload.startsWith('reschedule_')) {
        // Resposta à pergunta de reagendamento: worker quer ou não reagendar
        const result = await this.handleReminderResponseUseCase.execute(from, buttonPayload, originalMessageSid);
        if (result.isFailure) {
          console.warn(`[InboundWhatsApp] RescheduleResponse failed: ${result.error}`);
        }
      } else if (!templateSlug) {
        // OriginalRepliedMessageSid ausente ou não encontrado na outbox
        // Fallback: rotear pelo prefixo do ButtonPayload (compatibilidade / janela 7 dias)
        if (buttonPayload.startsWith('slot_')) {
          const result = await this.bookSlotUseCase.execute(from, buttonPayload, originalMessageSid);
          if (result.isFailure) {
            console.warn(`[InboundWhatsApp] BookSlot (fallback) failed: ${result.error}`);
          }
        } else if (buttonPayload.startsWith('confirm_')) {
          const result = await this.handleReminderResponseUseCase.execute(from, buttonPayload, originalMessageSid);
          if (result.isFailure) {
            console.warn(`[InboundWhatsApp] ReminderResponse (fallback) failed: ${result.error}`);
          }
        } else if (buttonPayload.startsWith('reschedule_')) {
          const result = await this.handleReminderResponseUseCase.execute(from, buttonPayload, originalMessageSid);
          if (result.isFailure) {
            console.warn(`[InboundWhatsApp] RescheduleResponse (fallback) failed: ${result.error}`);
          }
        } else {
          console.info('[InboundWhatsApp] Message ignored (unrecognized payload)', { from, buttonPayload });
        }
      } else {
        console.info('[InboundWhatsApp] Message ignored (template/payload mismatch)', {
          from, templateSlug, buttonPayload,
        });
      }
    } catch (err) {
      console.error('[InboundWhatsApp] Unexpected error:', err);
    }

    // 4. Twilio espera 200 OK
    res.status(200).send();
  }

  /**
   * Registra opt-out do worker. Normaliza phone whatsapp:+NNN → +NNN,
   * busca worker_id, insere em messaging_opt_out (ON CONFLICT = re-opt-out).
   */
  private async handleOptOut(from: string, keyword: string): Promise<void> {
    const phone = from.replace('whatsapp:', '');
    const log = logger.child({ phone, keyword, handler: 'OptOut' });

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
        console.info('[InboundWhatsApp] Free text captured as decline reason', { from });
        return true;
      }
      // Result.fail('No application awaiting reason') = worker não está em awaiting_reason
      return false;
    } catch (err) {
      console.warn('[InboundWhatsApp] tryHandleTextResponse error:', err);
      return false;
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
