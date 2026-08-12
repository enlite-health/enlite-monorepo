/**
 * Cliente HTTP minimalista para Twilio Content API.
 * Usa fetch nativo (Node 18+) + Basic auth.
 */

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

export interface WhatsAppApproval {
  status: 'approved' | 'pending' | 'received' | 'rejected' | 'unsubmitted';
  category?: string;
  name?: string;
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
      return (raw['whatsapp'] ?? null) as WhatsAppApproval | null;
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
export function extractBody(types: TwilioContent['types']): string {
  const order = [
    'twilio/text',
    'twilio/quick-reply',
    'twilio/call-to-action',
    'twilio/list-picker',
    'twilio/card',
  ];
  for (const key of order) {
    const t = types[key];
    if (!t) continue;
    if (t.body) return t.body;
    if (t.title) return t.title;
  }
  return '[Template não-textual — popular body manualmente]';
}
