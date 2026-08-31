import { Pool } from 'pg';
import { reportError, logger } from '@shared/logging';
import { extractContentBody, type ContentTypes } from './twilioContentBody';

/**
 * TwilioContentBodyProvider — traz da Content API o texto aprovado do template e
 * o GRAVA em `message_templates.body_twilio`.
 *
 * Por que existe: todo template de WhatsApp vive na Twilio; o que temos aqui em
 * `body` é a nossa versão com placeholders NOMEADOS, que existe para montar as
 * contentVariables no envio — e em vários casos ela nem é o texto (as migrations
 * gravaram `(ver Twilio Content Builder: HX…)`). Sem buscar lá, a tela não tem o
 * que mostrar para quem escolhe a mensagem.
 *
 * O sync em massa (`scripts/sync-message-templates-twilio.ts`) preenche a coluna
 * de uma vez. Este provider é o conserto preguiçoso do que ficou para trás: na
 * primeira vez que a tela pede, busca o que falta e persiste. Falha de rede não
 * derruba a tela — o campo continua null e a tela diz que não tem o texto.
 */

const CONTENT_API = 'https://content.twilio.com/v1/Content';

/** Teto por request: a tela só precisa do texto das candidatas, nunca das 27. */
export const MAX_LAZY_FETCH = 10;

export interface TemplateNeedingBody {
  slug: string;
  content_sid: string | null;
}

type Fetcher = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Teto por chamada: isto roda no caminho de uma request do painel. */
export const FETCH_TIMEOUT_MS = 3000;

/**
 * O texto aprovado do payload da Content API — mesma regra do sync, importada,
 * não copiada: os dois escrevem a MESMA coluna, e duas regras já produziram um
 * sentinela na tela como se fosse mensagem.
 */
export function bodyOfContentPayload(payload: unknown): string | null {
  return extractContentBody((payload as { types?: ContentTypes } | null)?.types);
}

export class TwilioContentBodyProvider {
  constructor(
    private readonly db: Pool,
    private readonly accountSid = process.env.TWILIO_ACCOUNT_SID,
    private readonly authToken = process.env.TWILIO_AUTH_TOKEN,
    private readonly fetchImpl: Fetcher = fetch as unknown as Fetcher,
  ) {}

  get configured(): boolean {
    return !!this.accountSid && !!this.authToken;
  }

  /**
   * Busca e persiste o corpo dos templates informados. Devolve slug → corpo só
   * dos que vieram; quem falhou fica de fora (a tela trata a ausência).
   */
  async fillMissing(templates: TemplateNeedingBody[]): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    if (!this.configured) {
      logger.warn({ msg: 'twilio_content_sem_credencial', pendentes: templates.length });
      return found;
    }
    const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');

    for (const tpl of templates.slice(0, MAX_LAZY_FETCH)) {
      if (!tpl.content_sid) continue;
      try {
        const res = await this.fetchImpl(`${CONTENT_API}/${tpl.content_sid}`, { headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`Content API ${res.status} para ${tpl.content_sid}`);
        const body = bodyOfContentPayload(await res.json());
        if (!body) {
          // Content respondeu 200 sem texto: não é erro de rede, mas também não
          // pode virar silêncio — é o caso que já mentiu na tela uma vez.
          logger.warn({ msg: 'twilio_content_sem_texto', slug: tpl.slug, contentSid: tpl.content_sid });
          continue;
        }
        // Sem `updated_at`: isto é efeito de uma LEITURA. E `IS DISTINCT FROM`
        // para N staff abrindo a tela juntos não escreverem o mesmo valor N vezes.
        await this.db.query(`UPDATE message_templates SET body_twilio = $2 WHERE slug = $1 AND body_twilio IS DISTINCT FROM $2`, [tpl.slug, body]);
        found.set(tpl.slug, body);
      } catch (error: unknown) {
        // Exibição: falhar aqui não pode derrubar a listagem da tela.
        reportError(error instanceof Error ? error : new Error(String(error)), { source: 'TwilioContentBodyProvider:fillMissing', slug: tpl.slug });
      }
    }
    return found;
  }
}
