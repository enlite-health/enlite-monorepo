import { IMessagingService } from '@modules/notification/domain/IMessagingService';
import { TwilioMessagingService } from '@modules/notification/infrastructure/TwilioMessagingService';
import { PeriskopeMessagingService } from '@modules/notification/infrastructure/PeriskopeMessagingService';
import { RoutingMessagingService } from '@modules/notification/infrastructure/RoutingMessagingService';
import { MessagingChannelPauseCache } from '@modules/notification/infrastructure/MessagingChannelPauseCache';
import { MessageTemplateRepository } from '@modules/notification/infrastructure/MessageTemplateRepository';
import { ChatwootClient } from '@modules/notification/infrastructure/ChatwootClient';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { logger } from '@shared/logging';

export interface MessagingServiceBundle {
  /** Fachada de roteamento — usada por OutboxProcessor e pelas rotas admin. */
  messagingService: IMessagingService;
  /** Concreto Twilio — usado por TriggerWorkerHandoverUseCase (injeta os DOIS concretos, não o router). */
  twilioMessagingService: TwilioMessagingService;
  /** Concreto Periskope — usado por TriggerWorkerHandoverUseCase. */
  periskopeMessagingService: PeriskopeMessagingService;
  /** Cache do kill-switch — exposto para invalidação manual (ex: endpoint admin de pause/unpause). */
  pauseCache: MessagingChannelPauseCache;
}

/**
 * Constrói os dois providers concretos de WhatsApp (Twilio + Periskope) e o
 * RoutingMessagingService por cima, que decide o canal por envio via
 * SendWhatsAppOptions.channel (fundação do roteamento por worker).
 *
 * MESSAGING_PROVIDER continua sendo o default global de fallback: quando um
 * caller não resolve o canal do worker (channel ausente), o envio cai no
 * provider indicado por esta env — preserva a semântica atual (rollout
 * global Chatwoot → Periskope via ROADMAP-PERISKOPE.md).
 */
export function buildMessagingService(
  templateRepo: MessageTemplateRepository,
  chatwootClient: ChatwootClient | null,
): MessagingServiceBundle {
  const provider = (process.env.MESSAGING_PROVIDER || 'twilio').toLowerCase();

  if (provider !== 'twilio' && provider !== 'periskope') {
    logger.warn({ msg: `[Messaging] MESSAGING_PROVIDER='${provider}' desconhecido — usando Twilio` });
  }
  const defaultChannel: 'twilio' | 'periskope' = provider === 'periskope' ? 'periskope' : 'twilio';
  logger.info({ msg: `[Messaging] Default channel (fallback): ${defaultChannel}` });

  const twilioMessagingService = new TwilioMessagingService(templateRepo, chatwootClient);
  const periskopeMessagingService = new PeriskopeMessagingService(templateRepo);
  const pauseCache = new MessagingChannelPauseCache(DatabaseConnection.getInstance().getPool());

  const messagingService = new RoutingMessagingService(
    twilioMessagingService,
    periskopeMessagingService,
    pauseCache,
    defaultChannel,
  );

  return { messagingService, twilioMessagingService, periskopeMessagingService, pauseCache };
}
