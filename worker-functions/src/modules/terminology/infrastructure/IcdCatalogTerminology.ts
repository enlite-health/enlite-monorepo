/**
 * IcdCatalogTerminology — Adapter (GoF) que implementa `TerminologyPort` sobre
 * `terminology.icd_entities`/`icd_releases` (migration 323). É o ÚNICO lugar de produção que
 * conhece o schema `terminology` — o caso de uso e a tela só veem a porta.
 *
 * 🔴 Nunca faz HTTP. `icd_uri` é identificador (licença 1.2.2), não endereço — este adaptador só
 * fala com o Postgres. Quem resolve endereço contra a OMS é só o ingestor
 * (`scripts/ingest-icd11-catalog.ts`), fora de produção, sempre reescrevendo o host
 * (`scripts/icd11-ingest/rewrite-host.ts`).
 *
 * Busca tolerante a erro (US-1) via `word_similarity` do `pg_trgm` — o que o `flexisearch` da
 * OMS não entrega (medido na F0: "esquisofrenia" → 0 resultados). `kind='extension'` (capítulo
 * X, códigos de pós-coordenação) fica fora por padrão — não é diagnóstico.
 *
 * 🔧 F1-CORREÇÕES (03/09, relatorio-f1-correcoes.md):
 * - D2: toda leitura resolve o release CORRENTE (`icd_releases WHERE is_current`) e filtra por
 *   ele — antes, `is_current` era um knob morto: nada em produção o lia, e o catálogo inteiro
 *   (todos os releases) ficava buscável o tempo todo.
 * - D3: `resolveCurrentRelease()` distingue "catálogo indisponível" (schema/tabela ausente, ou
 *   nenhum release marcado corrente) de "busca sem resultado" — o primeiro caso lança
 *   `TerminologyUnavailableError`, nunca devolve `[]`/`null` silencioso (US-4).
 * - D4: piso de 2 caracteres (após trim) antes de tocar o banco, e `%`/`_` escapados no ILIKE —
 *   sem isso, consulta curta ou curinga devolvia até 50 diagnósticos arbitrários com sim=0.
 * - D6: o predicado usa o operador indexável `%>` (comutador de `<%`, ambos GIN-friendly) em vez
 *   de `word_similarity(...) >= 0.3`, que NÃO é indexável — Seq Scan 212ms virou Bitmap Index
 *   Scan ~5ms (medido, ver evidencias/f1fix-D6-explain-analyze.txt). O limiar 0.3 é setado via
 *   `SET LOCAL` numa transação de uma única conexão dedicada — nunca `SET` global.
 * - D7: `code` sai como `IcdCode` (Value Object), construído aqui na leitura — não mais
 *   `string` crua vazando para quem consome a porta.
 * - D8: `limit` tem teto (`MAX_SEARCH_LIMIT`) — só este adaptador conhece o custo de uma busca
 *   maior, então só ele pode dizer não.
 */
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import type {
  TerminologyPort,
  DiagnosisCandidate,
  DiagnosisEntity,
  Chapter,
  Block,
  SearchOptions,
  IcdEntityKind,
} from '../domain/TerminologyPort';
import { IcdCode } from '../domain/IcdCode';
import { TerminologyUnavailableError } from '../domain/UnavailableTerminology';

const DEFAULT_SEARCH_LIMIT = 50;
/** D8 — medido: `search('a', { limit: 100000 })` sem teto devolveu 18.185 linhas. */
const MAX_SEARCH_LIMIT = 200;
/** D4 — abaixo disto, ILIKE '%'||q||'%' com q curto/curinga devolve lixo plausível (sim=0). */
const MIN_QUERY_LENGTH = 2;
const WORD_SIMILARITY_THRESHOLD = 0.3;

interface IcdEntityRow {
  icd_uri: string;
  code: string;
  title_es: string | null;
  title_en: string | null;
  chapter: string;
  release: string;
  kind: IcdEntityKind;
  is_leaf: boolean;
  parent_uri: string | null;
}

interface SearchRow {
  icd_uri: string;
  code: string;
  title_es: string | null;
  title_en: string | null;
  chapter: string;
}

export class TerminologyEntityNotFoundError extends Error {
  constructor(uri: string) {
    super(`Entidade CID-11 não encontrada no catálogo: ${uri}`);
    this.name = 'TerminologyEntityNotFoundError';
  }
}

function titleFor(row: { title_es: string | null; title_en: string | null }, lang: 'es' | 'en'): string {
  const primary = lang === 'en' ? row.title_en : row.title_es;
  const fallback = lang === 'en' ? row.title_es : row.title_en;
  return primary ?? fallback ?? '';
}

/** D4 — escapa `%`/`_` (curingas do LIKE/ILIKE) e a própria barra de escape. */
function escapeIlikeWildcards(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** D3 — traduz falha de infraestrutura (schema/tabela ausente) num erro tipado da porta. */
function toUnavailableError(err: unknown, fallbackReason: string): TerminologyUnavailableError {
  const pgCode = typeof err === 'object' && err !== null && 'code' in err ? (err as { code?: unknown }).code : undefined;
  if (pgCode === '42P01') {
    return new TerminologyUnavailableError('el esquema o las tablas del catálogo no existen');
  }
  return new TerminologyUnavailableError(fallbackReason);
}

export class IcdCatalogTerminology implements TerminologyPort {
  private poolMemo: Pool | undefined;

  private get pool(): Pool {
    this.poolMemo ??= DatabaseConnection.getInstance().getPool();
    return this.poolMemo;
  }

  /**
   * D2/D3 — resolve o release CORRENTE. Lança `TerminologyUnavailableError` quando: a
   * tabela/schema não existe (erro Postgres 42P01), ou existe mas nenhum release está marcado
   * `is_current` (catálogo nunca ingerido, ou ingerido mas nunca promovido — os dois casos são
   * indistinguíveis do ponto de vista de quem busca, e nos dois a resposta certa é "catálogo
   * indisponível", nunca `[]` silencioso).
   */
  private async resolveCurrentRelease(): Promise<string> {
    let rows: Array<{ release: string }>;
    try {
      ({ rows } = await this.pool.query<{ release: string }>(
        `SELECT release FROM terminology.icd_releases WHERE is_current = true LIMIT 1`,
      ));
    } catch (err) {
      throw toUnavailableError(err, 'error de infraestructura del catálogo de diagnósticos');
    }
    const current = rows[0];
    if (!current) {
      throw new TerminologyUnavailableError('no hay ningún release marcado como corriente');
    }
    return current.release;
  }

  async search(query: string, opts: SearchOptions = {}): Promise<DiagnosisCandidate[]> {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) return [];

    const currentRelease = await this.resolveCurrentRelease();

    const lang = opts.lang ?? 'es';
    const includeExtensions = opts.includeExtensions ?? false;
    const limit = Math.min(opts.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
    const chapters = opts.chapters && opts.chapters.length > 0 ? [...opts.chapters] : null;
    const escaped = escapeIlikeWildcards(trimmed);

    // D6: `%>` é o comutador de `<%` (word_similarity(a,b) >= limiar) e É indexável pelo GIN de
    // pg_trgm — ao contrário de `word_similarity(...) >= 0.3`, que força Seq Scan. O ILIKE
    // continua como reforço (casa substring exata mesmo abaixo do limiar de trigrama), agora com
    // o valor ESCAPADO (D4) para `%`/`_` do usuário não virarem curinga.
    const conditions: string[] = [
      `release = $2`,
      `(title_es %> $1 OR title_en %> $1 OR title_es ILIKE '%' || $3 || '%' ESCAPE '\\' OR title_en ILIKE '%' || $3 || '%' ESCAPE '\\')`,
      `kind <> 'chapter'`,
    ];
    const params: unknown[] = [trimmed, currentRelease, escaped];

    if (!includeExtensions) {
      conditions.push(`kind <> 'extension'`);
    }
    if (chapters) {
      params.push(chapters);
      conditions.push(`chapter = ANY($${params.length})`);
    }
    params.push(limit);

    const sql = `
      SELECT icd_uri, code, title_es, title_en, chapter,
             GREATEST(word_similarity($1, title_es), word_similarity($1, title_en)) AS sim
        FROM terminology.icd_entities
       WHERE ${conditions.join(' AND ')}
       ORDER BY sim DESC, code ASC
       LIMIT $${params.length}
    `;

    const rows = await this.runWithWordSimilarityThreshold<SearchRow>(sql, params);
    return rows.map((row) => ({
      uri: row.icd_uri,
      code: IcdCode.parse(row.code),
      title: titleFor(row, lang),
      chapter: row.chapter,
    }));
  }

  /**
   * D6 — `pg_trgm.word_similarity_threshold` só pode ser ajustado por sessão/consulta (CLAUDE.md:
   * nunca global). `SET LOCAL` exige estar dentro de uma transação, e só tem efeito garantido se
   * a query rodar na MESMA conexão física — por isso um `client` dedicado (`pool.connect()`), não
   * `pool.query()` duas vezes (que poderia pegar duas conexões diferentes do pool).
   */
  private async runWithWordSimilarityThreshold<T extends QueryResultRow>(
    sql: string,
    params: unknown[],
  ): Promise<T[]> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL pg_trgm.word_similarity_threshold = ${WORD_SIMILARITY_THRESHOLD}`);
      const { rows } = await client.query<T>(sql, params);
      await client.query('COMMIT');
      return rows;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getByUri(uri: string): Promise<DiagnosisEntity | null> {
    const currentRelease = await this.resolveCurrentRelease();
    const { rows } = await this.pool.query<IcdEntityRow>(
      `SELECT icd_uri, code, title_es, title_en, chapter, release, kind, is_leaf, parent_uri
         FROM terminology.icd_entities
        WHERE icd_uri = $1 AND release = $2`,
      [uri, currentRelease],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      uri: row.icd_uri,
      code: IcdCode.parse(row.code),
      titleEs: row.title_es,
      titleEn: row.title_en,
      chapter: row.chapter,
      release: row.release,
      kind: row.kind,
      isLeaf: row.is_leaf,
      parentUri: row.parent_uri,
    };
  }

  async ancestorsOf(uri: string): Promise<{ chapter: Chapter; block?: Block }> {
    const currentRelease = await this.resolveCurrentRelease();
    const { rows } = await this.pool.query<{ chapter: string }>(
      `SELECT chapter FROM terminology.icd_entities WHERE icd_uri = $1 AND release = $2`,
      [uri, currentRelease],
    );
    const found = rows[0];
    if (!found) throw new TerminologyEntityNotFoundError(uri);

    const { rows: chapterRows } = await this.pool.query<{ code: string; title_es: string | null; title_en: string | null }>(
      `SELECT code, title_es, title_en
         FROM terminology.icd_entities
        WHERE kind = 'chapter' AND code = $1 AND release = $2`,
      [found.chapter, currentRelease],
    );
    const chapterRow = chapterRows[0];
    if (!chapterRow) throw new TerminologyEntityNotFoundError(uri);

    // `block` fica sempre undefined: blocos da OMS (classKind='block') não têm `code` próprio e
    // não são gravados em terminology.icd_entities (ver COMMENT da migration 323) — limite
    // conhecido da F1, documentado no relatório (NAO CONSEGUI).
    return { chapter: { code: chapterRow.code, title: titleFor(chapterRow, 'es') } };
  }
}
