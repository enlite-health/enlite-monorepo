/**
 * Cliente HTTP minimalista para Twilio Content API.
 * Usa fetch nativo (Node 18+) + Basic auth.
 */

import { contentBodyOrSentinel } from '../../src/modules/notification/infrastructure/twilioContentBody';
import { logger } from '@shared/logging';

const TWILIO_BASE = 'https://content.twilio.com';

export interface TwilioContent {
  sid: string;
  friendly_name: string;
  language: string;
  variables: Record<string, string> | null;
  types: Record<string, { body?: string; title?: string; subtitle?: string }>;
  date_created: string;
  date_updated: string;
}

/**
 * Estados que a Twilio reporta para a aprovação WhatsApp.
 *
 * ⚠️ `paused` e `disabled` faltavam aqui até 31/08/2026, e a falta era pior do
 * que parecia. São os dois estados em que a Meta DESLIGA uma mensagem que já
 * estava no ar — pausada por retorno negativo recorrente (bloqueios, denúncias
 * de spam), desabilitada por reincidência ou violação de política. Como o valor
 * entrava por `as WhatsAppApproval` — um cast, não uma validação — um `paused`
 * passava sem reclamar em runtime, falhava no `=== 'approved'` do sync, e a
 * mensagem simplesmente SUMIA da sincronização. Uma cuidadora denunciando um
 * template derrubaria a linha dele da nossa base sem nada ficar vermelho.
 *
 * A Meta tem 10 estados (ver `MetaTemplateStatusProvider`); a Twilio expõe
 * estes. Desde 31/08 a fonte de verdade sobre estado é a Meta — este cliente
 * continua sendo de onde vêm os Contents e o `content_sid`.
 */
export const WHATSAPP_APPROVAL_STATUSES = [
  'approved',
  'pending',
  'received',
  'rejected',
  'unsubmitted',
  'paused',
  'disabled',
] as const;

export type WhatsAppApprovalStatus = (typeof WHATSAPP_APPROVAL_STATUSES)[number];

export interface WhatsAppApproval {
  status: WhatsAppApprovalStatus;
  /** Código do motivo da recusa. A Twilio devolve seco e às vezes vazio. */
  rejection_reason?: string;
  category?: string;
  name?: string;
}

/**
 * Valida o payload em vez de afirmá-lo.
 *
 * Devolve `null` quando não dá para confiar no que veio — e `null` aqui
 * significa "não sei", que é diferente de "não aprovado". Quem chama trata a
 * ausência; ninguém trata um cast mentiroso.
 *
 * Estado que não conhecemos NÃO vira erro nem vira `null`: vem preservado em
 * `unknownStatus`, porque descartar foi exatamente o que escondeu `paused` e
 * `disabled` de nós. A Meta acrescenta estado sem avisar.
 */
export function parseWhatsAppApproval(
  raw: unknown,
): { approval: WhatsAppApproval | null; unknownStatus: string | null } {
  if (raw === null || typeof raw !== 'object') return { approval: null, unknownStatus: null };
  const o = raw as Record<string, unknown>;
  const status = typeof o.status === 'string' ? o.status.toLowerCase() : null;
  if (!status) return { approval: null, unknownStatus: null };

  const known = (WHATSAPP_APPROVAL_STATUSES as readonly string[]).includes(status);
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

  return {
    approval: {
      status: status as WhatsAppApprovalStatus,
      rejection_reason: str(o.rejection_reason),
      category: str(o.category),
      name: str(o.name),
    },
    unknownStatus: known ? null : status,
  };
}

interface TwilioContentListResponse {
  contents: TwilioContent[];
  meta: { next_page_url: string | null };
}

export class TwilioContentClient {
  private readonly authHeader: string;

  constructor(accountSid: string, authToken: string) {
    this.authHeader = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;
  }

  async fetchAllContents(): Promise<TwilioContent[]> {
    const all: TwilioContent[] = [];
    let nextUrl: string | null = '/v1/Content?PageSize=100';
    while (nextUrl) {
      const page: TwilioContentListResponse = await this.get<TwilioContentListResponse>(nextUrl);
      all.push(...page.contents);
      nextUrl = page.meta?.next_page_url ?? null;
    }
    return all;
  }

  async fetchContent(sid: string): Promise<TwilioContent> {
    return this.get<TwilioContent>(`/v1/Content/${sid}`);
  }

  async fetchWhatsAppApproval(sid: string): Promise<WhatsAppApproval | null> {
    try {
      const raw = await this.get<Record<string, unknown>>(`/v1/Content/${sid}/ApprovalRequests`);
      // Validação, não cast: `as` aceitava qualquer coisa e o erro só aparecia
      // como ausência silenciosa lá na frente.
      const { approval, unknownStatus } = parseWhatsAppApproval(raw['whatsapp'] ?? null);
      if (unknownStatus) {
        logger.warn({ msg: 'twilio_approval_status_desconhecido', status: unknownStatus, contentSid: sid });
      }
      return approval;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (e.message.includes('404')) return null;
      throw e;
    }
  }

  private async get<T>(path: string): Promise<T> {
    const url = path.startsWith('http') ? path : `${TWILIO_BASE}${path}`;
    const res = await fetch(url, { headers: { Authorization: this.authHeader } });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Twilio ${res.status} ${res.statusText} on ${url}: ${text}`);
    }
    return res.json() as Promise<T>;
  }
}

/**
 * Extrai o `body` mais útil de um Content. Twilio expõe vários tipos
 * (text, quick-reply, card, etc.); tentamos em ordem de preferência.
 */
/**
 * @deprecated Use `extractContentBody` (texto real ou null) ou
 * `contentBodyOrSentinel` (para a coluna legada `body`, NOT NULL), ambos em
 * `src/modules/notification/infrastructure/twilioContentBody.ts`. Esta função
 * fica como re-export para não quebrar chamador antigo — a regra é uma só.
 */
export const extractBody = contentBodyOrSentinel;
