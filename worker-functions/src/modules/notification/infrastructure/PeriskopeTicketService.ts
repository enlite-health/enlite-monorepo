import { AxiosInstance } from 'axios';
import { createPeriskopeHttpClient } from './periskopeHttpClient';
import { IPeriskopeTicketService, TicketPriority } from '../domain/IPeriskopeTicketService';
import { logger, reportError, safeErrorFields } from '@shared/logging';
import { maskPhoneForLog } from '@shared/utils/phoneMask';

/**
 * PeriskopeTicketService — cria tickets no Periskope (gestão de fila humana),
 * conceito separado de envio de mensagem (ver IPeriskopeTicketService).
 *
 * Best-effort por contrato: nunca lança. Toda falha (não configurado, erro de
 * rede, erro HTTP) é logada e o método retorna `false` — o caller
 * (TriggerWorkerHandoverUseCase) segue o fluxo de handover normalmente mesmo
 * sem ticket criado.
 */
export class PeriskopeTicketService implements IPeriskopeTicketService {
  private http: AxiosInstance | null;
  private isConfigured: boolean;

  constructor() {
    this.http = createPeriskopeHttpClient();
    this.isConfigured = this.http !== null;

    if (!this.isConfigured) {
      logger.warn({ msg: '[PeriskopeTicketService] Not configured — ticket creation disabled' });
    }
  }

  async createTicket(
    chatPhone: string,
    subject: string,
    opts?: { assignee?: string; labels?: string; priority?: TicketPriority },
  ): Promise<boolean> {
    if (!this.isConfigured || !this.http) {
      logger.warn({ msg: '[PeriskopeTicketService] createTicket skipped — not configured' });
      return false;
    }

    const body: Record<string, string> = {
      chat_id: this.chatIdFor(chatPhone),
      subject,
      ...(opts?.assignee ? { assignee: opts.assignee } : {}),
      ...(opts?.labels ? { labels: opts.labels } : {}),
      ...(opts?.priority ? { priority: opts.priority } : {}),
    };

    try {
      await this.http.post('/tickets/create', body);
      return true;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      logger.warn({ ...safeErrorFields(err), chatPhone: maskPhoneForLog(chatPhone) }, '[PeriskopeTicketService] createTicket failed (best-effort)');
      reportError(e, { source: 'PeriskopeTicketService:createTicket' });
      return false;
    }
  }

  /** Periskope identifica chats 1-1 como <DDI+numero>@c.us (sem '+'). */
  private chatIdFor(e164: string): string {
    return `${e164.replace(/[^\d]/g, '')}@c.us`;
  }
}
