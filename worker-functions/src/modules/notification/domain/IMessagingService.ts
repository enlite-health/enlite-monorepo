import { Result } from '@shared/utils/Result';

export interface SendWhatsAppOptions {
  /** Número de destino em formato E.164: +5511999999999 */
  to: string;
  /** Slug do template em message_templates (ex: 'talent_search_welcome') */
  templateSlug: string;
  /** Variáveis para interpolação — ex: { name: 'Maria' } */
  variables?: Record<string, string>;
  /** Nome do contato — usado se o Chatwoot precisar criar o contato no espelho. */
  contactName?: string;
  /** Email do contato — usado se o Chatwoot precisar criar o contato no espelho. */
  contactEmail?: string;
}

export interface MessageSentResult {
  /** Twilio SID (in-process) ou ID da Cloud Function (futuro) */
  externalId: string;
  status: string;
  to: string;
}

export interface IMessagingService {
  sendWhatsApp(options: SendWhatsAppOptions): Promise<Result<MessageSentResult>>;
  /** Envia via Twilio Content API com contentSid e variáveis posicionais. */
  sendWithContentSid(
    to: string,
    contentSid: string,
    contentVariables: Record<string, string>,
  ): Promise<Result<MessageSentResult>>;
}
