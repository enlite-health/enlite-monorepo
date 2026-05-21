import axios, { AxiosInstance } from 'axios';

/**
 * Cliente da API do Chatwoot.
 *
 * Encapsula as operações necessárias pra espelhar uma mensagem outbound (já
 * enviada via Twilio) como `message_type=outgoing` no Chatwoot. O espelho
 * existe pra que a agente humana, ao receber a resposta do worker no Chatwoot,
 * tenha contexto do que foi perguntado.
 *
 * Dedup por source_id:
 *   Mensagens outgoing criadas COM source_id (o Twilio Message SID) são
 *   tratadas pelo Chatwoot como já entregues externamente, então o Twilio
 *   channel NÃO reenvia. Mensagens outgoing SEM source_id seriam reenviadas
 *   (comportamento de "agente digitou no dashboard").
 */
export interface ChatwootClientConfig {
  baseUrl: string;        // ex: https://chatwoot-production-0e81.up.railway.app
  apiToken: string;       // user/api_access_token com escopo Administrator
  accountId: number;      // ex: 1
  inboxId: number;        // inbox Twilio WhatsApp (Luz = 1)
}

export interface MirrorOutgoingOptions {
  /** Telefone E.164 (+5511...). Será prefixado com 'whatsapp:' no source_id. */
  phone: string;
  /** Nome do worker, pra popular o contato se ele ainda não existir. */
  name?: string;
  /** Email do worker, pra popular o contato se ele ainda não existir. */
  email?: string;
  /** Texto interpolado já legível (sem {{placeholders}}). */
  content: string;
  /** Twilio Message SID — usado como source_id pra dedup do Chatwoot. */
  twilioSid: string;
}

interface ContactInbox {
  source_id: string;
  inbox: { id: number };
}

interface ContactPayload {
  id: number;
  contact_inboxes?: ContactInbox[];
}

export class ChatwootClient {
  private http: AxiosInstance;
  private accountId: number;
  private inboxId: number;

  constructor(config: ChatwootClientConfig) {
    this.accountId = config.accountId;
    this.inboxId = config.inboxId;
    this.http = axios.create({
      baseURL: `${config.baseUrl.replace(/\/$/, '')}/api/v1/accounts/${config.accountId}`,
      headers: {
        api_access_token: config.apiToken,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });
  }

  /**
   * Espelha uma outbound já enviada via Twilio como mensagem outgoing no
   * Chatwoot. Idempotente em relação ao Twilio SID — se já houver mensagem
   * com esse source_id, o Chatwoot ignora.
   */
  async mirrorOutgoingMessage(opts: MirrorOutgoingOptions): Promise<void> {
    const { contactId, sourceId } = await this.findOrCreateContact(opts);
    const conversationId = await this.findOrCreateConversation(contactId, sourceId);
    await this.createOutgoingMessage(conversationId, opts.content, opts.twilioSid);
  }

  /**
   * Adiciona uma label ao contato (multi-add). No Chatwoot, labels de contato
   * são distintas de labels de conversa. Idempotente: o Chatwoot deduplica.
   */
  async addContactLabels(contactId: number, labels: string[]): Promise<void> {
    await this.http.post(`/contacts/${contactId}/labels`, { labels });
  }

  // ─── Privados ───────────────────────────────────────────────────────────────

  private async findOrCreateContact(
    opts: MirrorOutgoingOptions,
  ): Promise<{ contactId: number; sourceId: string }> {
    const found = await this.searchContactByPhone(opts.phone);
    if (found) {
      const sourceId = this.extractSourceIdForInbox(found, this.inboxId)
        ?? this.defaultSourceIdForPhone(opts.phone);
      return { contactId: found.id, sourceId };
    }

    const payload: Record<string, unknown> = {
      inbox_id: this.inboxId,
      phone_number: opts.phone,
    };
    if (opts.name) payload.name = opts.name;
    if (opts.email) payload.email = opts.email;

    const res = await this.http.post<{
      payload: { contact: ContactPayload; contact_inbox: { source_id: string } };
    }>('/contacts', payload);

    return {
      contactId: res.data.payload.contact.id,
      sourceId: res.data.payload.contact_inbox.source_id,
    };
  }

  private async searchContactByPhone(phone: string): Promise<ContactPayload | null> {
    // Chatwoot search aceita query parcial; passamos E.164 sem o '+' pra evitar URL-encode.
    const q = phone.startsWith('+') ? phone.slice(1) : phone;
    const res = await this.http.get<{ payload: ContactPayload[] }>('/contacts/search', {
      params: { q, include: 'contact_inboxes' },
    });
    const candidates = res.data.payload ?? [];
    // Match exato pelo phone — o search retorna parciais.
    return candidates.find((c: any) => normalizePhone(c.phone_number) === normalizePhone(phone))
      ?? candidates[0]
      ?? null;
  }

  private extractSourceIdForInbox(contact: ContactPayload, inboxId: number): string | null {
    const ci = contact.contact_inboxes?.find(c => c.inbox?.id === inboxId);
    return ci?.source_id ?? null;
  }

  private defaultSourceIdForPhone(phone: string): string {
    // Twilio WhatsApp source_id segue 'whatsapp:+5511999999999'.
    return `whatsapp:${phone.startsWith('+') ? phone : `+${phone}`}`;
  }

  private async findOrCreateConversation(
    contactId: number,
    sourceId: string,
  ): Promise<number> {
    // 1. Buscar conversa aberta no inbox correto
    const res = await this.http.get<{
      payload: Array<{ id: number; inbox_id: number; status: string }>;
    }>(`/contacts/${contactId}/conversations`);

    const existing = (res.data.payload ?? []).find(
      c => c.inbox_id === this.inboxId && c.status !== 'resolved',
    );
    if (existing) return existing.id;

    // 2. Criar nova
    const created = await this.http.post<{ id: number }>('/conversations', {
      source_id: sourceId,
      inbox_id: this.inboxId,
      contact_id: contactId,
    });
    return created.data.id;
  }

  private async createOutgoingMessage(
    conversationId: number,
    content: string,
    twilioSid: string,
  ): Promise<void> {
    await this.http.post(`/conversations/${conversationId}/messages`, {
      content,
      message_type: 'outgoing',
      private: false,
      source_id: twilioSid,
    });
  }
}

function normalizePhone(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.replace(/[^\d]/g, '');
}
