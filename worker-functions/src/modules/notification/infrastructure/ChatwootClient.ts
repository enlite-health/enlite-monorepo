import axios, { AxiosInstance } from 'axios';
import { normalizePhoneAR } from '@shared/utils/phoneNormalization';

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

export interface MirrorIncomingOptions {
  /** Telefone E.164 (+5511...) do worker que respondeu. */
  phone: string;
  /** Nome do worker, pra popular o contato se ele ainda não existir. */
  name?: string;
  /** Texto que o worker enviou. */
  content: string;
  /** ID único do inbound (Twilio MessageSid) — source_id pra dedup/idempotência. */
  externalId: string;
}

interface ContactInbox {
  source_id: string;
  inbox: { id: number };
}

interface ContactPayload {
  id: number;
  /** E.164 como o Chatwoot guarda (com ou sem o 9 de móvel argentino). */
  phone_number?: string | null;
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
   * Espelha a resposta INBOUND do worker (que chegou pelo Twilio no worker-functions)
   * como mensagem `incoming` no Chatwoot. Isso faz o Chatwoot disparar o webhook
   * `message_created` → a Luz (triage-service) processa e responde. É o elo que
   * liga a resposta do convite (que hoje morre no InboundWhatsAppController) ao motor
   * da Luz, reusando 100% do pipeline reativo. Idempotente por `externalId` (source_id).
   */
  async mirrorIncomingMessage(opts: MirrorIncomingOptions): Promise<void> {
    const { contactId, sourceId } = await this.findOrCreateContact(opts);
    const conversationId = await this.findOrCreateConversation(contactId, sourceId);
    await this.createIncomingMessage(conversationId, opts.content, opts.externalId);
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
    opts: { phone: string; name?: string; email?: string },
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
    // Chatwoot faz busca por SUBSTRING. Procurar por '541171148942' não acha
    // '5491171148942' (o 9 no meio quebra a substring), mas os últimos 10
    // dígitos — o número local — são comuns às duas variantes. É por aí que a
    // gente reencontra o contato que o inbound do WhatsApp criou.
    const digits = phone.replace(/\D/g, '');
    const q = digits.length > 10 ? digits.slice(-10) : digits;
    const res = await this.http.get<{ payload: ContactPayload[] }>('/contacts/search', {
      params: { q, include: 'contact_inboxes' },
    });
    const candidates = res.data.payload ?? [];
    const wanted = phoneMatchKey(phone);
    const matches = candidates.filter(
      (c: ContactPayload) => phoneMatchKey(c.phone_number) === wanted,
    );
    if (matches.length > 0) {
      // Onde JÁ existe o par duplicado (as duas variantes viraram dois
      // contatos), fica com o que tem thread neste inbox — é a conversa que a
      // pessoa enxerga. Sem isso o espelho continuaria alimentando o contato
      // órfão e a divisão se perpetuaria.
      return (
        matches.find((c) => this.extractSourceIdForInbox(c, this.inboxId)) ?? matches[0]
      );
    }
    // Sem match canônico: só aceita o palpite quando a busca devolveu UM
    // candidato. Com vários, escolher o primeiro é apostar em qual pessoa
    // recebe a mensagem — melhor criar contato novo do que mandar pra outra.
    return candidates.length === 1 ? candidates[0] : null;
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

  private async createIncomingMessage(
    conversationId: number,
    content: string,
    externalId: string,
  ): Promise<void> {
    await this.http.post(`/conversations/${conversationId}/messages`, {
      content,
      message_type: 'incoming',
      private: false,
      source_id: externalId,
    });
  }
}

/**
 * Chave de comparação de telefone entre o que ESTÁ no Chatwoot e o que a gente
 * manda.
 *
 * Só tirar não-dígitos não bastava: a mesma pessoa entra pelo WhatsApp como
 * `+54 9 11 7114-8942` (13 dígitos, com o 9 de móvel que a operadora exige) e
 * sai da nossa base como `+54 11 7114-8942` (12, o formato que veio da
 * planilha). Digits-only faz `5491171148942 !== 541171148942`, então o espelho
 * não achava o contato do inbound e criava um SEGUNDO contato — histórico
 * partido em duas threads (caso Carina: convs 1112/1114 num contato,
 * 1148/1149 no outro; a operadora responde uma e não vê a outra).
 *
 * `normalizePhoneAR` resolve as duas variantes no mesmo canônico 549… e deixa
 * número não-AR (BR, 55…) intacto.
 */
export function phoneMatchKey(raw: string | null | undefined): string {
  if (!raw) return '';
  return normalizePhoneAR(raw.replace(/[^\d]/g, ''));
}
