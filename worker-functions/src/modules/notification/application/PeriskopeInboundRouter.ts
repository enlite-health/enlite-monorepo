import { Pool } from 'pg';
import { logger } from '@shared/logging';
import { BookSlotFromWhatsAppUseCase } from './BookSlotFromWhatsAppUseCase';
import { HandleReminderResponseUseCase } from './HandleReminderResponseUseCase';
import { TemplateButton } from '../domain/MessageTemplate';
import { parseNumberedReply } from '../domain/numberedButtonOptions';
import {
  INTERVIEW_INVITE_SLUG,
  LEGACY_INVITE_SLUG,
  REMINDER_CONFIRM_SLUG,
  REMINDER_RESCHEDULE_SLUG,
} from '../domain/interviewFlowTemplateSlugs';

/**
 * Janela de correlação: uma resposta numerada só é roteada se a última
 * mensagem com botões enviada pro worker foi enviada dentro desses N dias.
 * O fluxo Twilio não tem proteção equivalente explícita em SQL (o fallback
 * por prefixo de ButtonPayload em InboundWhatsAppController não filtra por
 * tempo) — adotamos 7 dias como TTL defensivo, alinhado ao
 * MAX_PENDING_AGE_DAYS do OutboxProcessor (mesma ordem de grandeza de
 * "mensagem stale" já usada no módulo).
 */
const CORRELATION_WINDOW_DAYS = 7;

interface ButtonOutboxCorrelator {
  template_slug: string;
  twilio_sid: string | null;
  buttons: TemplateButton[];
}

/**
 * PeriskopeInboundRouter — item 2.3 da migração Twilio → Periskope.
 *
 * Roteia respostas numeradas ("1", "2"...) digitadas pelo worker no
 * WhatsApp Web (sem botões interativos) para os mesmos use cases que o
 * canal Twilio usa via ButtonPayload/OriginalRepliedMessageSid
 * (InboundWhatsAppController):
 *
 *   1. Resolve worker pelo telefone.
 *   2. Busca em messaging_outbox a mensagem mais recente (status='sent',
 *      dentro da janela de correlação) cujo template tem botões
 *      (message_templates.buttons IS NOT NULL) — essa é a correlação:
 *      não existe OriginalRepliedMessageSid no Periskope.
 *   3. Usa numberedButtonOptions.parseNumberedReply (mesmo parser usado
 *      pelo outbound em PeriskopeMessagingService) para mapear o número
 *      digitado ao TemplateButton correspondente.
 *   4. Roteia por template_slug + prefixo do payload do botão, replicando
 *      a tabela de decisão do InboundWhatsAppController.
 *
 * O twilio_sid da mensagem correlacionada é repassado como
 * originalMessageSid aos use cases — mesmo mecanismo de correlação exata
 * do canal Twilio (a coluna messaging_outbox.twilio_sid é compartilhada
 * entre providers; OutboxProcessor grava o externalId do Periskope nela).
 */
export class PeriskopeInboundRouter {
  constructor(
    private readonly db: Pool,
    private readonly bookSlotUseCase: BookSlotFromWhatsAppUseCase,
    private readonly handleReminderResponseUseCase: HandleReminderResponseUseCase,
  ) {}

  /**
   * Tenta rotear bodyText como resposta numerada.
   *
   * Retorna true se uma mensagem correlacionável foi encontrada E o número
   * apontou pra um botão reconhecido (independente do use case ter tido
   * sucesso — a resposta já foi consumida, não deve cair no fallback).
   * Retorna false em qualquer outro caso (worker não encontrado, sem
   * correlator, texto não-numérico, fora do range, slug/payload não
   * reconhecido) — o caller deve seguir o fluxo atual
   * (awaiting_reason / ignorar).
   */
  async routeNumberedReply(phone: string, bodyText: string): Promise<boolean> {
    const worker = await this.findWorker(phone);
    if (!worker) return false;

    const correlator = await this.findRecentButtonMessage(worker.id);
    if (!correlator) return false;

    const button = parseNumberedReply(bodyText, correlator.buttons);
    if (!button) return false;

    return this.dispatch(phone, correlator.template_slug, button, correlator.twilio_sid);
  }

  private async findWorker(phone: string): Promise<{ id: string } | null> {
    const result = await this.db.query<{ id: string }>(
      `SELECT id FROM workers WHERE phone = $1 LIMIT 1`,
      [phone],
    );
    return result.rows[0] ?? null;
  }

  private async findRecentButtonMessage(workerId: string): Promise<ButtonOutboxCorrelator | null> {
    const result = await this.db.query<ButtonOutboxCorrelator>(
      `SELECT mo.template_slug, mo.twilio_sid, mt.buttons
       FROM messaging_outbox mo
       JOIN message_templates mt ON mt.slug = mo.template_slug
       WHERE mo.worker_id = $1
         AND mo.status = 'sent'
         AND mt.buttons IS NOT NULL
         AND mo.created_at > NOW() - ($2::text || ' days')::interval
       ORDER BY mo.created_at DESC
       LIMIT 1`,
      [workerId, CORRELATION_WINDOW_DAYS],
    );
    return result.rows[0] ?? null;
  }

  private async dispatch(
    phone: string,
    templateSlug: string,
    button: TemplateButton,
    originalMessageSid: string | null,
  ): Promise<boolean> {
    const sid = originalMessageSid ?? undefined;

    if (
      (templateSlug === INTERVIEW_INVITE_SLUG || templateSlug === LEGACY_INVITE_SLUG)
      && button.payload.startsWith('slot_')
    ) {
      const result = await this.bookSlotUseCase.execute(phone, button.payload, sid);
      if (result.isFailure) {
        logger.warn({ phone, templateSlug, error: result.error }, '[PeriskopeInboundRouter] BookSlot failed');
      }
      return true;
    }

    if (templateSlug === REMINDER_CONFIRM_SLUG && button.payload.startsWith('confirm_')) {
      const result = await this.handleReminderResponseUseCase.execute(phone, button.payload, sid);
      if (result.isFailure) {
        logger.warn({ phone, templateSlug, error: result.error }, '[PeriskopeInboundRouter] ReminderResponse failed');
      }
      return true;
    }

    if (templateSlug === REMINDER_RESCHEDULE_SLUG && button.payload.startsWith('reschedule_')) {
      const result = await this.handleReminderResponseUseCase.execute(phone, button.payload, sid);
      if (result.isFailure) {
        logger.warn({ phone, templateSlug, error: result.error }, '[PeriskopeInboundRouter] RescheduleResponse failed');
      }
      return true;
    }

    logger.info(
      { phone, templateSlug, payload: button.payload },
      '[PeriskopeInboundRouter] Correlated message found but slug/payload not recognized',
    );
    return false;
  }
}
