import { AxiosInstance } from 'axios';
import { logger, reportError, safeErrorFields } from '@shared/logging';
import { maskPhoneForLog } from '@shared/utils/phoneMask';
import { createPeriskopeHttpClient } from './periskopeHttpClient';

/**
 * PeriskopeNoteService — posta NOTAS internas no chat do worker no Periskope.
 *
 * Nota é *"only visible on Periskope, not sent to WhatsApp"* (doc oficial) → é o
 * mecanismo seguro de ESPELHO: o time de recrutamento vê a conversa da Luz sem que
 * o bot envie nada pelo Periskope (bot no Periskope = ban). O `chat_id` 1-1 é
 * construído do telefone (`<dígitos>@c.us`), sem precisar de chat pré-existente —
 * mesmo padrão do PeriskopeTicketService.
 *
 * Best-effort por contrato: nunca lança. Requer PERISKOPE_API_KEY + PERISKOPE_PHONE
 * (auth) e, para a nota, `performed_by` (email de um membro) + `org_id` (uuid). O
 * `org_id` é auto-descoberto via GET /chats?limit=1 se PERISKOPE_ORG_ID não estiver
 * setado (a doc/rule: o chat object traz org_id).
 */
export class PeriskopeNoteService {
  private http: AxiosInstance | null;
  private isConfigured: boolean;
  private author: string | undefined;
  private orgId: string | undefined;

  constructor() {
    this.author = process.env.PERISKOPE_NOTE_AUTHOR;
    this.orgId = process.env.PERISKOPE_ORG_ID;

    const http = createPeriskopeHttpClient();
    this.isConfigured = !!(http && this.author);
    this.http = this.isConfigured ? http : null;

    if (!this.isConfigured) {
      logger.warn({ msg: '[PeriskopeNoteService] Not configured (falta API_KEY/PHONE/NOTE_AUTHOR) — notas desabilitadas' });
    }
  }

  /** Posta uma nota interna no chat 1-1 do worker (por telefone E.164). */
  async mirrorAsNote(workerPhone: string, message: string): Promise<boolean> {
    if (!this.isConfigured || !this.http) return false;
    if (!message.trim()) return false;

    try {
      const orgId = await this.resolveOrgId();
      if (!orgId) {
        logger.warn({ msg: '[PeriskopeNoteService] org_id indisponível — nota pulada' });
        return false;
      }
      await this.http.post('/note/create', {
        chat_id: this.chatIdFor(workerPhone),
        message,
        performed_by: this.author,
        org_id: orgId,
      });
      return true;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      logger.warn({ ...safeErrorFields(err), workerPhone: maskPhoneForLog(workerPhone) }, '[PeriskopeNoteService] mirrorAsNote failed (best-effort)');
      // ⚠️ NÃO CONSERTADO AQUI (decisão do Gabriel, PR separado): o `warn` acima está
      // mascarado, mas `reportError` manda `err` inteiro pro MESMO Cloud Error Reporting
      // — `message`/`stack` do erro (que pode ecoar `workerPhone`/corpo da request) ainda
      // saem crus por este segundo sink. O teste desta classe MOCKA `reportError`, então
      // não cobre este caminho — ver comentário no `.test.ts`.
      reportError(e, { source: 'PeriskopeNoteService:mirrorAsNote' });
      return false;
    }
  }

  /** org_id do env, ou auto-descoberto via GET /chats?limit=1 (cacheado). */
  private async resolveOrgId(): Promise<string | undefined> {
    if (this.orgId) return this.orgId;
    if (!this.http) return undefined;
    try {
      const res = await this.http.get<{ chats?: Array<{ org_id?: string }> }>('/chats', { params: { limit: 1 } });
      this.orgId = res.data?.chats?.[0]?.org_id;
      return this.orgId;
    } catch {
      return undefined;
    }
  }

  /** Periskope identifica chats 1-1 como <DDI+numero>@c.us (sem '+'). */
  private chatIdFor(e164: string): string {
    return `${e164.replace(/[^\d]/g, '')}@c.us`;
  }
}
