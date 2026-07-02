import { IMessagingService } from '@modules/notification/domain/IMessagingService';
import { TwilioMessagingService } from '@modules/notification/infrastructure/TwilioMessagingService';
import { PeriskopeMessagingService } from '@modules/notification/infrastructure/PeriskopeMessagingService';
import { MessageTemplateRepository } from '@modules/notification/infrastructure/MessageTemplateRepository';
import { ChatwootClient } from '@modules/notification/infrastructure/ChatwootClient';
import { logger } from '@shared/logging';

/**
 * Seleciona o provider de WhatsApp pela env MESSAGING_PROVIDER:
 *   - 'twilio' (default): canal WABA oficial via Twilio + espelho Chatwoot.
 *   - 'periskope': WhatsApp Web gerenciado via Periskope (sem templates,
 *     sem espelho — a inbox humana é o próprio Periskope).
 *
 * Flag global de rollout da migração Chatwoot → Periskope
 * (ver docs/roadmaps/ROADMAP-PERISKOPE.md no repo do chatbot).
 */
export function buildMessagingService(
  templateRepo: MessageTemplateRepository,
  chatwootClient: ChatwootClient | null,
): IMessagingService {
  const provider = (process.env.MESSAGING_PROVIDER || 'twilio').toLowerCase();

  if (provider === 'periskope') {
    logger.info({ msg: '[Messaging] Provider: Periskope' });
    return new PeriskopeMessagingService(templateRepo);
  }

  if (provider !== 'twilio') {
    logger.warn({ msg: `[Messaging] MESSAGING_PROVIDER='${provider}' desconhecido — usando Twilio` });
  }
  return new TwilioMessagingService(templateRepo, chatwootClient);
}
