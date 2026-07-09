import { IMessagingService, MessageSentResult, SendWhatsAppOptions } from '../domain/IMessagingService';
import { MessagingChannelPauseCache } from './MessagingChannelPauseCache';
import { Result } from '@shared/utils/Result';

/**
 * Erro exato retornado quando o canal Periskope está pausado no kill-switch.
 * Exportado para que OutboxProcessor (e qualquer outro caller que precise)
 * reconheça esta falha como reprocessável — não incrementa `attempts` nem
 * marca a linha como failed, diferente de qualquer outro erro de envio.
 */
export const PERISKOPE_PAUSED_ERROR = 'periskope channel paused';

/**
 * RoutingMessagingService — fachada IMessagingService que decide, por envio,
 * qual provider concreto (Twilio ou Periskope) processa a mensagem.
 *
 * Fundação do roteamento por worker: cada SendWhatsAppOptions.channel diz
 * qual canal usar; ausência de channel cai no `defaultChannel` (resolvido a
 * partir de MESSAGING_PROVIDER em buildMessagingService, preservando a
 * semântica atual da env para callers que ainda não resolvem o canal do
 * worker).
 *
 * Kill-switch: antes de despachar pro Periskope, consulta
 * MessagingChannelPauseCache. Se pausado, falha com PERISKOPE_PAUSED_ERROR —
 * o Periskope concreto NUNCA é chamado. Esta falha é fallback instantâneo
 * sem deploy (flipar messaging_channel_pause.paused).
 */
export class RoutingMessagingService implements IMessagingService {
  constructor(
    private readonly twilio: IMessagingService,
    private readonly periskope: IMessagingService,
    private readonly pauseCache: MessagingChannelPauseCache,
    private readonly defaultChannel: 'twilio' | 'periskope' = 'twilio',
  ) {}

  async sendWhatsApp(options: SendWhatsAppOptions): Promise<Result<MessageSentResult>> {
    const channel = options.channel ?? this.defaultChannel;

    if (channel === 'periskope') {
      const paused = await this.pauseCache.isPaused('periskope');
      if (paused) {
        return Result.fail<MessageSentResult>(PERISKOPE_PAUSED_ERROR);
      }
      return this.periskope.sendWhatsApp(options);
    }

    return this.twilio.sendWhatsApp(options);
  }

  /**
   * Content API é um conceito exclusivo do canal Twilio/WABA (Periskope não
   * tem equivalente — ver PeriskopeMessagingService.sendWithContentSid).
   * SendWhatsAppOptions.channel não existe nesta assinatura porque nenhum
   * caller atual precisa rotear este método por worker; sempre delega Twilio.
   */
  async sendWithContentSid(
    to: string,
    contentSid: string,
    contentVariables: Record<string, string>,
  ): Promise<Result<MessageSentResult>> {
    return this.twilio.sendWithContentSid(to, contentSid, contentVariables);
  }
}
