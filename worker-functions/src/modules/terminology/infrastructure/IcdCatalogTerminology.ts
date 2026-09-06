/**
 * IcdCatalogTerminology — Adapter (GoF) que implementa `TerminologyPort` sobre
 * `terminology.icd_entities`/`icd_releases`/`icd_synonyms` (migrations 323 e 328). É o ÚNICO
 * lugar de produção que conhece o schema `terminology` — o caso de uso e a tela só veem a porta.
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
 *   ele — antes, `is_current` era um knob morto: nada em produção o lia.
 * - D3: `resolveCurrentRelease()` distingue "catálogo indisponível" (schema/tabela ausente, ou
 *   nenhum release marcado corrente) de "busca sem resultado" — o primeiro caso lança
 *   `TerminologyUnavailableError`, nunca devolve `[]`/`null` silencioso (US-4).
 * - D4: piso de caracteres antes de tocar o banco (hoje `MIN_SEARCH_QUERY_LENGTH`, da porta —
 *   ver T10 abaixo), e `%`/`_` escapados no ILIKE.
 * - D6: o predicado usa o operador indexável `%>` (comutador de `<%`, ambos GIN-friendly) em vez
 *   de `word_similarity(...) >= 0.3`, que NÃO é indexável — Seq Scan 212ms virou Bitmap Index
 *   Scan ~5ms. O limiar 0.3 é setado via `SET LOCAL` numa transação de uma única conexão
 *   dedicada — nunca `SET` global.
 * - D7: `code` sai como `IcdCode` (Value Object), construído aqui na leitura.
 * - D8: `limit` tem teto (`MAX_SEARCH_LIMIT`).
 *
 * ── 🔧 F5-CORREÇÕES (QA-caça, 05/09/2026) ────────────────────────────────────────────────────
 *
 * T2 — RESOLUÇÃO POR `concept_key`, NÃO POR `icd_uri`. A URI canônica da OMS carrega o release
 * DENTRO do path (`.../icd/release/11/2026-01/mms/405565289`), então o MESMO conceito tem URI
 * DIFERENTE em cada release. Quem guardou uma URI e pede para resolvê-la sob o release corrente
 * — o mapa `clickup_diagnosis_labels` (migration 327), a linha `patient_diagnoses.concept_uri` —
 * recebia `null` no dia da primeira promoção. Os 8 mapeamentos do ClickUp morriam DE UMA VEZ, e
 * em silêncio (`concept_not_resolved`, log `info`, webhook 200, nenhuma linha de rejeição).
 * `concept_key` (coluna GERADA, migration 328) é a identidade estável entre releases; a mesma
 * função SQL `terminology.concept_key()` normaliza a URI que CHEGA. Uma regra, um lugar.
 *
 * T3 — `asOfRelease?` SAIU de `getByUri`/`ancestorsOf`: nenhum chamador de produção jamais o
 * passou, e a causa que ele contornava era o defeito T2 acima. Ver o COMMENT do port.
 *
 * T7 — `TerminologyEntityNotFoundError` NÃO carrega mais a URI do conceito na `message`. O
 * `reportError` loga `err.message` JUNTO do `patientId` (AdminPatientDiagnosesController) — a
 * dupla "quem é o paciente" + "qual o conceito clínico" é exatamente o que a regra dura do
 * projeto proíbe em log. A causa continua no tipo do erro; a identidade clínica, não.
 *
 * T8 — `ROLLBACK` que falha não pode SUBSTITUIR o erro original (o `instanceof` de quem chama
 * erra e o cliente recebe 500 no lugar de 409). `.catch(() => undefined)`, igual ao irmão
 * `ReadonlyDbQueryService`.
 *
 * T9 — `terminology.icd_synonyms` DEIXA de ser um knob morto: a busca passa a lê-la. A migration
 * 323 cria a tabela com índice trigrama próprio e um COMMENT que INSTRUI a operação a cadastrar
 * ali o termo que o trigrama dos títulos não cobre (gíria, sigla regional: `TEA`, `TDAH`) — e
 * ZERO linha de produção a lia. Quem seguisse a instrução gravada no schema cadastrava, via
 * zero, e não tinha sinal nenhum de que o cadastro era inerte.
 *
 * T10 — o piso de tamanho da consulta vem da PORTA (`MIN_SEARCH_QUERY_LENGTH`), não de uma
 * constante local — antes eram 3 lugares com 2 valores.
 */
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import {
  MIN_SEARCH_QUERY_LENGTH,
  type TerminologyPort,
  type DiagnosisCandidate,
  type DiagnosisEntity,
  type Chapter,
  type Block,
  type SearchOptions,
  type IcdEntityKind,
} from '../domain/TerminologyPort';
import { IcdCode } from '../domain/IcdCode';
import { TerminologyUnavailableError } from '../domain/UnavailableTerminology';

const DEFAULT_SEARCH_LIMIT = 50;
/** D8 — medido: `search('a', { limit: 100000 })` sem teto devolveu 18.185 linhas. */
const MAX_SEARCH_LIMIT = 200;
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

/**
 * T7 — a `message` NÃO nomeia o conceito. O `reportError` (`src/shared/logging/ErrorReporter.ts`)
 * loga `err.message` e `err.stack` junto do `patientId`; uma URI de CID-11 ao lado do id do
 * paciente é dado clínico identificado saindo do perímetro pelo log. "Contagem e status, sempre"
 * — o TIPO do erro já é o status, e é o que o chamador precisa para decidir o HTTP.
 */
export class TerminologyEntityNotFoundError extends Error {
  constructor() {
    super('Entidade não encontrada no catálogo de terminologia');
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

const INFRA_FAILURE_REASON = 'error de infraestructura del catálogo de diagnósticos';

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
      throw toUnavailableError(err, INFRA_FAILURE_REASON);
    }
    const current = rows[0];
    if (!current) {
      throw new TerminologyUnavailableError('no hay ningún release marcado como corriente');
    }
    return current.release;
  }

  async search(query: string, opts: SearchOptions = {}): Promise<DiagnosisCandidate[]> {
    const trimmed = query.trim();
    if (trimmed.length < MIN_SEARCH_QUERY_LENGTH) return [];

    const currentRelease = await this.resolveCurrentRelease();

    const lang = opts.lang ?? 'es';
    const includeExtensions = opts.includeExtensions ?? false;
    const limit = Math.min(opts.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
    const chapters = opts.chapters && opts.chapters.length > 0 ? [...opts.chapters] : null;
    const escaped = escapeIlikeWildcards(trimmed);

    const conditions: string[] = [`e.kind <> 'chapter'`];
    const params: unknown[] = [trimmed, currentRelease, escaped];

    if (!includeExtensions) {
      conditions.push(`e.kind <> 'extension'`);
    }
    if (chapters) {
      params.push(chapters);
      conditions.push(`e.chapter = ANY($${params.length})`);
    }
    params.push(limit);

    // D6: `%>` é o comutador de `<%` (word_similarity(a,b) >= limiar) e É indexável pelo GIN de
    // pg_trgm — ao contrário de `word_similarity(...) >= 0.3`, que força Seq Scan. O ILIKE
    // continua como reforço (casa substring exata mesmo abaixo do limiar de trigrama), com o
    // valor ESCAPADO (D4).
    //
    // T9: os dois candidatos entram por CTEs SEPARADAS e se juntam por `UNION ALL` — de
    // propósito. A forma óbvia (`... OR EXISTS (SELECT 1 FROM icd_synonyms s WHERE
    // s.icd_uri = e.icd_uri AND ...)`) é uma subconsulta CORRELACIONADA dentro de um `OR`: ela
    // obriga o Postgres a avaliar linha a linha e joga fora o Bitmap Index Scan que o D6 mediu
    // e conquistou. Assim, cada ramo usa o SEU índice trigrama (o dos títulos em
    // `icd_entities`, o de `term` em `icd_synonyms`) e só depois o resultado — pequeno — é
    // juntado ao catálogo pela `icd_uri`.
    const sql = `
      WITH por_titulo AS (
        SELECT t.icd_uri,
               GREATEST(word_similarity($1, t.title_es), word_similarity($1, t.title_en)) AS sim
          FROM terminology.icd_entities t
         WHERE t.release = $2
           AND (t.title_es %> $1 OR t.title_en %> $1
                OR t.title_es ILIKE '%' || $3 || '%' ESCAPE '\\'
                OR t.title_en ILIKE '%' || $3 || '%' ESCAPE '\\')
      ),
      por_sinonimo AS (
        SELECT s.icd_uri, max(word_similarity($1, s.term)) AS sim
          FROM terminology.icd_synonyms s
         WHERE s.release = $2
           AND (s.term %> $1 OR s.term ILIKE '%' || $3 || '%' ESCAPE '\\')
         GROUP BY s.icd_uri
      ),
      candidatos AS (
        SELECT icd_uri, sim FROM por_titulo
        UNION ALL
        SELECT icd_uri, sim FROM por_sinonimo
      )
      SELECT e.icd_uri, e.code, e.title_es, e.title_en, e.chapter, max(c.sim) AS sim
        FROM candidatos c
        JOIN terminology.icd_entities e
          ON e.icd_uri = c.icd_uri AND e.release = $2
       WHERE ${conditions.join(' AND ')}
       GROUP BY e.icd_uri, e.code, e.title_es, e.title_en, e.chapter
       ORDER BY sim DESC, e.code ASC
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
      // T8 — um ROLLBACK que falha (conexão já derrubada, transação abortada) NÃO pode
      // substituir o erro real: quem chama decide o HTTP por `instanceof`, e o erro trocado vira
      // 500 no lugar do código certo. Mesmo padrão de `ReadonlyDbQueryService`.
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * T2 — casa por `concept_key` (a identidade estável entre releases, migration 328), nunca por
   * `icd_uri` cru: a URI da OMS muda a cada release e faria o mesmo conceito virar "inexistente"
   * assim que outro release fosse promovido. `terminology.concept_key($1)` normaliza a URI que
   * chega pela MESMA regra que gerou a coluna — e, sendo IMMUTABLE, o planner a trata como
   * constante e usa o índice `(release, concept_key)`.
   */
  async getByUri(uri: string): Promise<DiagnosisEntity | null> {
    const release = await this.resolveCurrentRelease();
    let rows: IcdEntityRow[];
    try {
      ({ rows } = await this.pool.query<IcdEntityRow>(
        `SELECT icd_uri, code, title_es, title_en, chapter, release, kind, is_leaf, parent_uri
           FROM terminology.icd_entities
          WHERE concept_key = terminology.concept_key($1) AND release = $2`,
        [uri, release],
      ));
    } catch (err) {
      throw toUnavailableError(err, INFRA_FAILURE_REASON);
    }
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
    const release = await this.resolveCurrentRelease();
    let rows: Array<{ chapter: string }>;
    try {
      ({ rows } = await this.pool.query<{ chapter: string }>(
        `SELECT chapter FROM terminology.icd_entities
          WHERE concept_key = terminology.concept_key($1) AND release = $2`,
        [uri, release],
      ));
    } catch (err) {
      throw toUnavailableError(err, INFRA_FAILURE_REASON);
    }
    const found = rows[0];
    if (!found) throw new TerminologyEntityNotFoundError();

    const { rows: chapterRows } = await this.pool.query<{ code: string; title_es: string | null; title_en: string | null }>(
      `SELECT code, title_es, title_en
         FROM terminology.icd_entities
        WHERE kind = 'chapter' AND code = $1 AND release = $2`,
      [found.chapter, release],
    );
    const chapterRow = chapterRows[0];
    if (!chapterRow) throw new TerminologyEntityNotFoundError();

    // `block` fica sempre undefined: blocos da OMS (classKind='block') não têm `code` próprio e
    // não são gravados em terminology.icd_entities (ver COMMENT da migration 323) — limite
    // conhecido da F1, documentado no relatório (NAO CONSEGUI).
    return { chapter: { code: chapterRow.code, title: titleFor(chapterRow, 'es') } };
  }
}
