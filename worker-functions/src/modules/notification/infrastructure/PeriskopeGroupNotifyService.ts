import { AxiosInstance } from 'axios';
import { createPeriskopeHttpClient } from './periskopeHttpClient';
import { logger, reportError } from '@shared/logging';

/**
 * PeriskopeGroupNotifyService — envia mensagem a um GRUPO do Periskope (`@g.us`),
 * o canal interno do time (ex.: "Reclutamiento Enlite"). NUNCA candidato: o
 * `chat_id` é validado como grupo — enviar 1-1 por aqui é bug, não feature
 * (candidato só recebe pelo canal oficial Twilio/WABA).
 *
 * Best-effort por contrato: nunca lança. Toda falha (não configurado, erro de
 * rede, erro HTTP) é logada e o método retorna `false` — o caller segue o fluxo.
 */
export class PeriskopeGroupNotifyService {
  private http: AxiosInstance | null;
  private isConfigured: boolean;

  constructor() {
    this.http = createPeriskopeHttpClient();
    this.isConfigured = this.http !== null;

    if (!this.isConfigured) {
      logger.warn({ msg: '[PeriskopeGroupNotifyService] Not configured — group notify disabled' });
    }
  }

  async sendToGroup(groupChatId: string, message: string): Promise<boolean> {
    if (!this.isConfigured || !this.http) {
      logger.warn({ msg: '[PeriskopeGroupNotifyService] sendToGroup skipped — not configured' });
      return false;
    }
    if (!groupChatId.endsWith('@g.us')) {
      logger.warn(
        { groupChatId },
        '[PeriskopeGroupNotifyService] sendToGroup rejected — chat_id is not a group',
      );
      return false;
    }

    try {
      await this.http.post('/message/send', { chat_id: groupChatId, message });
      return true;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      logger.warn(
        { error: e.message, groupChatId },
        '[PeriskopeGroupNotifyService] sendToGroup failed (best-effort)',
      );
      reportError(e, { source: 'PeriskopeGroupNotifyService:sendToGroup' });
      return false;
    }
  }
}
