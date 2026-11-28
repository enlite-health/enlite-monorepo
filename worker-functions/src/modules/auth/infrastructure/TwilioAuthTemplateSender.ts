import { logger, safeErrorFields } from '@shared/logging';
import { maskPhoneForLog } from '@shared/utils/phoneMask';
import { shouldSuppressOtp } from '../application/IsTestOtpGuard';
import { OTP_CHANNEL_UNAVAILABLE } from '../ports/OtpChallengePort';
import type { OtpSendContext } from '../ports/OtpChallengePort';

/** Pedaço do cliente Twilio que o sender usa: `client.messages.create`. Injetável, para o teste usar dublê (sem rede). */
export interface TwilioMessagesClient {
  messages: {
    create(params: {
      to: string;
      from?: string;
      messagingServiceSid?: string;
      contentSid: string;
      contentVariables: string;
    }): Promise<{ sid: string }>;
  };
}

export interface TwilioAuthTemplateSenderConfig {
  /** `ContentSid` (HX…) do template de AUTENTICAÇÃO aprovado na Meta (TWILIO_AUTH_TEMPLATE_CONTENT_SID). */
  contentSid: string;
  /** Número da Luz (E.164, sem `whatsapp:`) — TWILIO_WHATSAPP_NUMBER. Ou, no lugar dele, um Messaging Service. */
  fromNumber?: string;
  messagingServiceSid?: string;
}

export interface OtpSendResult {
  /** Ausente quando o envio foi suprimido pela guarda de ficha de teste. */
  twilioSid?: string;
  suppressed: boolean;
}

/**
 * Envia o código OTP por template de AUTENTICAÇÃO do WhatsApp (botão OTP), pelo número da Luz: Programmable Messaging,
 * `ContentSid` + `ContentVariables {"1":"<código>"}` (D758). O código nunca vai para log; o telefone só mascarado.
 *
 * Falha do Twilio → `OTP_CHANNEL_UNAVAILABLE`, uma tentativa só, sem fallback para SMS (D732).
 * FR-95: ficha `is_test` + token `@enlite.test` → o cliente NÃO é chamado.
 */
export class TwilioAuthTemplateSender {
  constructor(
    private readonly client: TwilioMessagesClient,
    private readonly config: TwilioAuthTemplateSenderConfig,
  ) {}

  async send(input: { toE164: string; code: string; ctx?: OtpSendContext }): Promise<OtpSendResult> {
    const log = logger.child({ source: 'TwilioAuthTemplateSender:send', phoneMasked: maskPhoneForLog(input.toE164) });

    if (shouldSuppressOtp(input.ctx)) {
      log.info({ msg: 'otp_template_suppressed_is_test' });
      return { suppressed: true };
    }

    const sender = this.config.messagingServiceSid
      ? { messagingServiceSid: this.config.messagingServiceSid }
      : { from: `whatsapp:${this.config.fromNumber ?? ''}` };

    try {
      const message = await this.client.messages.create({
        to: `whatsapp:${input.toE164}`,
        ...sender,
        contentSid: this.config.contentSid,
        contentVariables: JSON.stringify({ '1': input.code }),
      });
      log.info({ msg: 'otp_template_sent', twilioSid: message.sid });
      return { twilioSid: message.sid, suppressed: false };
    } catch (err: unknown) {
      log.warn({ msg: 'otp_template_send_failed', ...safeErrorFields(err) });
      throw new Error(OTP_CHANNEL_UNAVAILABLE, { cause: err });
    }
  }
}
