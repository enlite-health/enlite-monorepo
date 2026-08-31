import { Pool } from 'pg';
import { reportError, logger } from '@shared/logging';

/**
 * MetaTemplateStatusProvider — lê o estado de autorização dos templates
 * DIRETO DA META e o grava em `message_templates`.
 *
 * Por que a Meta e não a Twilio (medido em 31/08/2026, conta de produção):
 *
 *   1. A Twilio reporta 5 estados; a Meta reporta 10. Os cinco que faltavam
 *      incluem PAUSED e DISABLED — os que dizem que uma mensagem QUE ESTAVA NO
 *      AR foi desligada por denúncia de spam. O que a Twilio não representa,
 *      nós não enxergávamos.
 *   2. O motivo da recusa que a Twilio repassa vem seco. A documentação dela
 *      diz que `INVALID_FORMAT` chega "without explaining details". A Meta manda
 *      a explicação em prosa e a recomendação de conserto.
 *   3. O estado JÁ era buscado da Twilio e jogado fora: o `collectApprovedTwilio`
 *      guardava só `approved` e descartava o resto a cada sync.
 *
 * A Twilio continua sendo de onde vêm os Contents e o `content_sid` — ela deixa
 * de ser fonte de verdade sobre ESTADO, não sobre existência.
 *
 * ⚖️ Leitura autorizada: `GET /{waba}/message_templates` está na allowlist do
 * parecer de 29/08 (D220.2). Este arquivo NÃO escreve na Meta — qualquer
 * POST/PUT/DELETE lá é outra decisão, e ela não foi tomada.
 */

const GRAPH_BASE = 'https://graph.facebook.com/v21.0';

/** Teto por chamada. Isto roda em script de sync, não no caminho de uma request. */
export const FETCH_TIMEOUT_MS = 10_000;

/** Teto de páginas, para um cursor quebrado não virar laço infinito. */
export const MAX_PAGES = 20;

type Fetcher = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<unknown> }>;

/** Um template como a Meta o descreve. `status` fica cru de propósito — ver `normalizeStatus`. */
export interface MetaTemplate {
  name: string;
  language: string;
  status: string;
  category: string | null;
  qualityScore: string | null;
  id: string | null;
}

/** O que casou com uma linha nossa, pronto para gravar. */
export interface MetaStatusUpdate {
  contentSid: string;
  status: string;
  language: string;
  category: string | null;
  qualityScore: string | null;
}

/**
 * O `content_sid` escondido dentro do nome do template na Meta.
 *
 * ⚠️ Esta é a chave de junção entre os dois mundos, e ela não é convenção nossa
 * — é da Twilio. Quando ela submete um Content à Meta, cria o template com o
 * nome `<friendly_name>_<content_sid em minúsculas>`:
 *
 *     Twilio  friendly_name : ar_invite_luz_personal
 *             sid           : HX5d77ccab1689ab6cf9b675a0b158e68d
 *     Meta    name          : ar_invite_luz_personal_hx5d77ccab1689ab6cf9b675a0b158e68d
 *
 * Medido em 31/08/2026 contra a WABA de produção: 27 de 27 templates casam com
 * o SID exato do Content correspondente, e ZERO existem sem esse sufixo. Ou
 * seja, todo template daquela conta nasceu na Twilio.
 *
 * Devolve `null` para nome sem o sufixo — e `null` aqui é informação, não erro:
 * significa "este template não veio da Twilio", que é o caso que precisaríamos
 * ver se alguém passasse a criar direto na Meta. Nunca casar por aproximação de
 * nome: dois templates podem compartilhar o mesmo `friendly_name` em idiomas
 * diferentes, e o SID é o que os separa.
 */
export function contentSidFromMetaName(name: string): string | null {
  const m = /^(?:.+)_(hx[0-9a-f]{32})$/.exec(name);
  return m ? m[1].toUpperCase() : null;
}

/**
 * Estado como a Meta escreve, normalizado só na caixa.
 *
 * 🔒 NÃO valida contra uma lista fechada, e isso é deliberado. A Meta acrescenta
 * estado sem avisar, e foi exatamente o descarte do que não se reconhecia que
 * escondeu PAUSED e DISABLED de nós até agora. Guardar o desconhecido é a regra;
 * quem lê decide o que fazer com ele. Um `0` de estados desconhecidos tanto pode
 * significar "nada novo" quanto "não olhei".
 */
export function normalizeStatus(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim().toUpperCase() : null;
}

/** Um item do payload da Meta, sem confiar em nada. */
export function parseMetaTemplate(raw: unknown): MetaTemplate | null {
  if (raw === null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === 'string' ? o.name : null;
  const status = normalizeStatus(o.status);
  if (!name || !status) return null;

  const q = o.quality_score;
  const qualityScore =
    q !== null && typeof q === 'object' && typeof (q as Record<string, unknown>).score === 'string'
      ? ((q as Record<string, unknown>).score as string).toUpperCase()
      : null;

  return {
    name,
    language: typeof o.language === 'string' ? o.language : '',
    status,
    category: typeof o.category === 'string' ? o.category : null,
    qualityScore,
    id: typeof o.id === 'string' ? o.id : null,
  };
}

export interface SyncResult {
  /** Templates lidos da Meta. */
  fetched: number;
  /** Casaram com uma linha nossa e foram gravados. */
  matched: number;
  /** Vieram sem o sufixo de SID — não nasceram na Twilio. */
  withoutContentSid: string[];
  /** SID presente na Meta e ausente da nossa tabela. */
  unknownToUs: string[];
  /** Estados que não estão nos 10 documentados. Lista, nunca descarte. */
  unknownStatuses: string[];
}

export class MetaTemplateStatusProvider {
  constructor(
    private readonly db: Pool,
    private readonly wabaId = process.env.WABA_ID,
    private readonly token = process.env.WABA_TOKEN,
    private readonly fetchImpl: Fetcher = fetch as unknown as Fetcher,
  ) {}

  get configured(): boolean {
    return !!this.wabaId && !!this.token;
  }

  /** Todas as páginas de `GET /{waba}/message_templates`. */
  async fetchAll(): Promise<MetaTemplate[]> {
    if (!this.configured) {
      logger.warn({ msg: 'meta_templates_sem_credencial' });
      return [];
    }
    const out: MetaTemplate[] = [];
    const fields = 'name,language,status,category,quality_score,id';
    let url: string | null = `${GRAPH_BASE}/${this.wabaId}/message_templates?fields=${fields}&limit=100`;

    for (let page = 0; url && page < MAX_PAGES; page++) {
      const res = await this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        // Sem o corpo do erro no log: ele pode ecoar o token na URL.
        throw new Error(`Meta Graph ${res.status} ao listar templates da WABA`);
      }
      const body = (await res.json()) as { data?: unknown[]; paging?: { next?: string } };
      for (const item of body.data ?? []) {
        const t = parseMetaTemplate(item);
        if (t) out.push(t);
      }
      url = typeof body.paging?.next === 'string' ? body.paging.next : null;
    }
    return out;
  }

  /**
   * Lê da Meta e grava o estado nas linhas que casarem.
   *
   * Nada é descartado em silêncio: o que não casa volta no resultado, nomeado.
   * Contagem zero de "não casou" só vale se alguém tiver olhado — por isso as
   * listas vêm preenchidas, não só contadas.
   */
  async syncStatuses(): Promise<SyncResult> {
    const templates = await this.fetchAll();
    const result: SyncResult = {
      fetched: templates.length,
      matched: 0,
      withoutContentSid: [],
      unknownToUs: [],
      unknownStatuses: [],
    };

    const known = await this.knownContentSids();

    for (const t of templates) {
      const sid = contentSidFromMetaName(t.name);
      if (!sid) {
        result.withoutContentSid.push(t.name);
        continue;
      }
      if (!known.has(sid)) {
        result.unknownToUs.push(sid);
        continue;
      }
      if (!DOCUMENTED_STATUSES.has(t.status) && !result.unknownStatuses.includes(t.status)) {
        result.unknownStatuses.push(t.status);
      }
      try {
        await this.persist({
          contentSid: sid,
          status: t.status,
          language: t.language,
          category: t.category,
          qualityScore: t.qualityScore,
        });
        result.matched++;
      } catch (error: unknown) {
        reportError(error instanceof Error ? error : new Error(String(error)), {
          source: 'MetaTemplateStatusProvider:persist',
          contentSid: sid,
        });
      }
    }

    if (result.withoutContentSid.length > 0) {
      logger.warn({
        msg: 'meta_template_sem_content_sid',
        total: result.withoutContentSid.length,
        nomes: result.withoutContentSid,
      });
    }
    if (result.unknownStatuses.length > 0) {
      logger.warn({ msg: 'meta_status_desconhecido', estados: result.unknownStatuses });
    }
    return result;
  }

  private async knownContentSids(): Promise<Set<string>> {
    const r = await this.db.query<{ content_sid: string }>(
      `SELECT content_sid FROM message_templates WHERE content_sid IS NOT NULL`,
    );
    return new Set(r.rows.map((x) => x.content_sid.toUpperCase()));
  }

  /**
   * `IS DISTINCT FROM` no estado para não reescrever a linha quando nada mudou;
   * o carimbo de verificação, esse, atualiza sempre — ele responde "quando foi a
   * última vez que olhamos", não "quando mudou".
   */
  private async persist(u: MetaStatusUpdate): Promise<void> {
    await this.db.query(
      `UPDATE message_templates
          SET meta_approval_status  = $2,
              meta_approval_checked_at = NOW()
        WHERE UPPER(content_sid) = $1
          AND (meta_approval_status IS DISTINCT FROM $2 OR meta_approval_checked_at IS NULL
               OR meta_approval_checked_at < NOW() - INTERVAL '1 minute')`,
      [u.contentSid, u.status],
    );
  }
}

/**
 * Os 10 estados que a Meta documenta hoje. Serve só para SINALIZAR o que está
 * fora da lista — nunca para filtrar. Ver `normalizeStatus`.
 */
export const DOCUMENTED_STATUSES: ReadonlySet<string> = new Set([
  'APPROVED',
  'IN_APPEAL',
  'PENDING',
  'REJECTED',
  'PENDING_DELETION',
  'DELETED',
  'DISABLED',
  'PAUSED',
  'LIMIT_EXCEEDED',
  'ARCHIVED',
]);
