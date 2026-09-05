/**
 * 🔧 F5-CORREÇÃO T9 (QA-caça, 05/09/2026) — `terminology.icd_synonyms` era um KNOB MORTO.
 *
 * A migration 323 cria a tabela, dá a ela um índice trigrama próprio, e escreve um `COMMENT ON
 * TABLE` que INSTRUI a operação: *"esta tabela é para termo que o trigram não cobrir (gíria,
 * sigla regional), adicionado editorialmente pela operação"*. E ZERO linha de produção a lia:
 * `grep -rn "icd_synonyms" src scripts front` não devolvia nada (controle positivo: o mesmo grep
 * achava 19 ocorrências de `icd_entities`). Quem seguisse a instrução gravada no schema
 * cadastraria, veria zero, e não teria sinal nenhum de que o cadastro é inerte.
 *
 * Importa porque a auditoria de UX já mediu que `TDAH`, `TEA` e `F84` voltam "sem resultado" —
 * prometer um escape hatch que não existe é pior que não ter.
 *
 * Postgres real, sem mock. As fixtures são prefixadas `T2D-` e removidas no `afterAll`.
 */
import { Pool } from 'pg';
import { IcdCatalogTerminology } from '../../src/modules/terminology/infrastructure/IcdCatalogTerminology';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
/**
 * Sigla que o trigrama dos TÍTULOS oficiais não cobre — é o caso de uso inteiro da tabela.
 * MEDIDA, não escolhida por intuição: no release 2026-01, o predicado de título (`%>` + ILIKE,
 * limiar 0.3) devolve 0 linhas para este termo. Usar "TEA" cru NÃO serviria como controle: ele
 * casa 1.789 títulos por substring ("protea...", "meningitea..."), e o teste passaria a medir
 * outra coisa.
 */
const SIGLA = 'T2DZQXW';

describe('T9 — a busca LÊ terminology.icd_synonyms (Postgres real) @integration', () => {
  let pool: Pool;
  let terminology: IcdCatalogTerminology;
  let releaseCorrente = '';
  let alvoUri = '';
  let alvoTitulo = '';

  const limpar = () => pool.query(`DELETE FROM terminology.icd_synonyms WHERE term LIKE 'T2D%'`);

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    terminology = new IcdCatalogTerminology();
    releaseCorrente = (
      await pool.query<{ release: string }>(`SELECT release FROM terminology.icd_releases WHERE is_current`)
    ).rows[0].release;
    // Escolhe um alvo REAL do catálogo (não uma entidade fabricada por mim — D187).
    const alvo = (
      await pool.query<{ icd_uri: string; title_es: string }>(
        `SELECT icd_uri, title_es FROM terminology.icd_entities
          WHERE release = $1 AND kind = 'stem' AND title_es IS NOT NULL AND chapter = '06' LIMIT 1`,
        [releaseCorrente],
      )
    ).rows[0];
    alvoUri = alvo.icd_uri;
    alvoTitulo = alvo.title_es;
    await limpar();
  });

  afterAll(async () => {
    await limpar();
    await pool.end();
  });

  it('CONTROLE — a sigla, ANTES de cadastrar o sinônimo, não acha nada (o buraco medido pela UX)', async () => {
    expect(await terminology.search(SIGLA)).toEqual([]);
  });

  it('depois de cadastrar o sinônimo, a MESMA busca acha a entidade — e devolve o TÍTULO OFICIAL', async () => {
    await pool.query(
      `INSERT INTO terminology.icd_synonyms (icd_uri, release, term, lang, created_by)
       VALUES ($1, $2, $3, 'es', 'T2D-qa')`,
      [alvoUri, releaseCorrente, SIGLA],
    );

    const out = await terminology.search(SIGLA);

    expect(out.length).toBeGreaterThan(0);
    const achado = out.find((c) => c.uri === alvoUri);
    expect(achado).toBeDefined();
    // Cláusula 1.2.3: o título continua sendo o da OMS — o sinônimo é só um caminho de BUSCA,
    // nunca substitui nem traduz o título oficial.
    expect(achado!.title).toBe(alvoTitulo);
  });

  it('o sinônimo é escopado por RELEASE — cadastrado noutro release, não vaza para a busca corrente', async () => {
    await limpar();
    // Um release que existe mas não é o corrente: cria um só para isto e apaga em seguida.
    await pool.query(
      `INSERT INTO terminology.icd_releases (release, entity_count) VALUES ('T2D-OUTRO', 0) ON CONFLICT DO NOTHING`,
    );
    try {
      // A FK é composta (icd_uri, release) — sem linha da entidade naquele release, o INSERT é
      // impossível. Isso já É a garantia de escopo, e o teste a exercita explicitamente.
      await expect(
        pool.query(
          `INSERT INTO terminology.icd_synonyms (icd_uri, release, term, lang, created_by)
           VALUES ($1, 'T2D-OUTRO', $2, 'es', 'T2D-qa')`,
          [alvoUri, SIGLA],
        ),
      ).rejects.toMatchObject({ code: '23503' });
      expect(await terminology.search(SIGLA)).toEqual([]);
    } finally {
      await pool.query(`DELETE FROM terminology.icd_releases WHERE release = 'T2D-OUTRO'`);
    }
  });

  it('D6 NÃO regrediu: o plano da busca continua por ÍNDICE, não Seq Scan sobre 35.692 linhas', async () => {
    await limpar();
    await pool.query(
      `INSERT INTO terminology.icd_synonyms (icd_uri, release, term, lang, created_by)
       VALUES ($1, $2, $3, 'es', 'T2D-qa')`,
      [alvoUri, releaseCorrente, SIGLA],
    );

    const client = await pool.connect();
    let plano = '';
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL pg_trgm.word_similarity_threshold = 0.3');
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN ANALYZE
         WITH por_titulo AS (
           SELECT t.icd_uri, GREATEST(word_similarity($1, t.title_es), word_similarity($1, t.title_en)) AS sim
             FROM terminology.icd_entities t
            WHERE t.release = $2
              AND (t.title_es %> $1 OR t.title_en %> $1
                   OR t.title_es ILIKE '%' || $3 || '%' ESCAPE '\\'
                   OR t.title_en ILIKE '%' || $3 || '%' ESCAPE '\\')
         ),
         por_sinonimo AS (
           SELECT s.icd_uri, max(word_similarity($1, s.term)) AS sim
             FROM terminology.icd_synonyms s
            WHERE s.release = $2 AND (s.term %> $1 OR s.term ILIKE '%' || $3 || '%' ESCAPE '\\')
            GROUP BY s.icd_uri
         ),
         candidatos AS (SELECT icd_uri, sim FROM por_titulo UNION ALL SELECT icd_uri, sim FROM por_sinonimo)
         SELECT e.icd_uri, e.code, max(c.sim) AS sim
           FROM candidatos c JOIN terminology.icd_entities e ON e.icd_uri = c.icd_uri AND e.release = $2
          WHERE e.kind <> 'chapter' AND e.kind <> 'extension'
          GROUP BY e.icd_uri, e.code ORDER BY sim DESC LIMIT 50`,
        ['esquisofrenia', releaseCorrente, 'esquisofrenia'],
      );
      plano = rows.map((r) => r['QUERY PLAN']).join('\n');
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    // O ganho do D6 (Bitmap Index Scan sobre o GIN de trigrama) continua no plano...
    expect(plano).toMatch(/Bitmap Index Scan/);
    // ...e nenhum Seq Scan varre a tabela grande do catálogo.
    expect(plano).not.toMatch(/Seq Scan on icd_entities/);
  });
});
