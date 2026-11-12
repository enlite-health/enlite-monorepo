/**
 * Busca do catálogo CID-11 por PALAVRA e sem acento (migration 561 + `IcdCatalogTerminology.search`),
 * contra o Postgres real, sem mock. Mesmo molde de `t9-synonym-search.e2e.test.ts`: fixtures em
 * capítulo `99` (que o catálogo real não tem) com palavras inventadas (`zqw…`), removidas no fim.
 *
 * Trava quatro comportamentos decididos com o Gabriel (03/11/2026):
 *  a. sem acento: "depresion" acha "depresión";
 *  b. por palavra: "trastorno desarrollo intelectual" (sem "del", outra ordem) acha 6A00;
 *  c. AND: palavras de entidades diferentes não casam por pedaço solto (antes casavam);
 *  d. consulta só de stopwords cai na frase inteira (o comportamento de antes);
 *  e. palavra com menos de 5 caracteres não casa por similaridade (só por ILIKE);
 *  f. empate de score: título da OMS vem antes de sinônimo.
 */
import { Pool } from 'pg';
import { IcdCatalogTerminology } from '../../src/modules/terminology/infrastructure/IcdCatalogTerminology';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const URI = (n: number) => `http://id.who.int/icd/release/11/test-palavra/mms/77000${n}`;

describe('busca por palavra, sem acento (Postgres real) @integration', () => {
  let pool: Pool;
  let terminology: IcdCatalogTerminology;
  let release = '';

  const limpar = async () => {
    await pool.query(`DELETE FROM terminology.icd_synonyms WHERE icd_uri LIKE '%/test-palavra/%'`);
    await pool.query(`DELETE FROM terminology.icd_entities WHERE icd_uri LIKE '%/test-palavra/%'`);
  };
  const inserir = (n: number, code: string, titleEs: string) =>
    pool.query(
      `INSERT INTO terminology.icd_entities (icd_uri, release, code, title_es, title_en, chapter, kind, is_leaf)
       VALUES ($1, $2, $3, $4, NULL, '99', 'stem', true)`,
      [URI(n), release, code, titleEs],
    );
  const buscar = async (q: string, opts: { chapters?: string[] } = {}) =>
    (await terminology.search(q, { chapters: opts.chapters ?? ['99'] })).map((c) => c.code.value);

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    terminology = new IcdCatalogTerminology();
    release = (await pool.query<{ release: string }>(`SELECT release FROM terminology.icd_releases WHERE is_current`)).rows[0]
      .release;
    await limpar();
  });
  afterEach(limpar);
  afterAll(async () => {
    await limpar();
    await pool.end();
  });

  it('a. "zqwdepresion" (sem acento, outra caixa) acha o título com "zqwdepresión"', async () => {
    await inserir(1, 'ZQ01', 'Trastorno zqwdepresión grave');

    // CONTROLE: o texto cru NÃO casa com a consulta sem acento — é o buraco de antes.
    const cru = await pool.query(`SELECT 1 FROM terminology.icd_entities WHERE icd_uri = $1 AND title_es ILIKE '%zqwdepresion%'`, [URI(1)]);
    expect(cru.rowCount).toBe(0);

    expect(await buscar('zqwdepresion')).toEqual(['ZQ01']);
    expect(await buscar('ZQWDEPRESIÓN')).toEqual(['ZQ01']);

    // O trigrama sozinho já perdoa 1 acento (acha mesmo sem unaccent) — o que o unaccent muda é o
    // "contém a frase": com ele, o título com acento vem ANTES do que só é parecido, mesmo com code maior.
    await inserir(10, 'ZQ00', 'zqwdepresiot trastorno'); // só parecido; code menor
    expect(await buscar('zqwdepresion')).toEqual(['ZQ01', 'ZQ00']);
  });

  it('b. sem "del" e em outra ordem acha a entidade; no catálogo real acha 6A00.0', async () => {
    await inserir(2, 'ZQ02', 'Trastorno del desarrollo zqwintelectual, leve');
    expect(await buscar('zqwintelectual desarrollo trastorno')).toEqual(['ZQ02']);
    expect(await buscar('trastorno desarrollo zqwintelectual')).toEqual(['ZQ02']);
    // stopword na consulta ("para" não está no título) é descartada, não exigida
    expect(await buscar('trastorno para desarrollo zqwintelectual')).toEqual(['ZQ02']);

    const real = await terminology.search('trastorno desarrollo intelectual', { chapters: ['06'] });
    expect(real.map((c) => c.code.value)).toContain('6A00.0');
  });

  it('c. palavras de entidades DIFERENTES não casam por pedaço solto (antes casava)', async () => {
    await inserir(3, 'ZQ03', 'zqwalfaxyz uno');
    await inserir(4, 'ZQ04', 'plimtorbus dos');

    // CONTROLE: a regra antiga (frase inteira, `%>` no limiar 0.3) casava a entidade só por uma palavra.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL pg_trgm.word_similarity_threshold = 0.3');
      const r = await client.query(
        `SELECT 1 FROM terminology.icd_entities WHERE icd_uri LIKE '%/test-palavra/%' AND title_es %> 'zqwalfaxyz plimtorbus'`,
      );
      expect(r.rowCount).toBeGreaterThan(0);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    expect(await buscar('zqwalfaxyz plimtorbus')).toEqual([]);
    // e cada palavra sozinha continua achando a sua entidade
    expect(await buscar('zqwalfaxyz')).toEqual(['ZQ03']);
    expect(await buscar('plimtorbus')).toEqual(['ZQ04']);
  });

  it('d. consulta só de stopwords cai na frase inteira (comportamento de antes)', async () => {
    await inserir(5, 'ZQ05', 'zqwcuadro sin con zqwfin');
    await inserir(6, 'ZQ06', 'zqwoutro sin nada con zqwfin');

    // Frase inteira como bloco: ZQ05 a CONTÉM e vem em 1º; ZQ06 só casa por similaridade (como antes) e vem depois.
    expect(await buscar('sin con')).toEqual(['ZQ05', 'ZQ06']);
  });

  it('e. palavra com menos de 5 caracteres não casa por similaridade; com 5+ continua tolerante a erro', async () => {
    await inserir(11, 'ZQ30', 'zqwcuadro leva');
    await inserir(12, 'ZQ31', 'zqwesquizofrenia');

    // CONTROLE: pela regra antiga, "leve" (4 letras) casava "leva" por similaridade.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL pg_trgm.word_similarity_threshold = 0.3');
      const r = await client.query(`SELECT 'leve' <% 'zqwcuadro leva' AS casa`);
      expect(r.rows[0].casa).toBe(true);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    expect(await buscar('zqwcuadro leve')).toEqual([]); // "leve" curta: só ILIKE, e "leva" não a contém
    expect(await buscar('zqwcuadro leva')).toEqual(['ZQ30']);
    expect(await buscar('zqwesquisofrenia')).toEqual(['ZQ31']); // 16 letras, erro de digitação: fuzzy vale
  });

  it('f. com score igual, o TÍTULO da OMS vem antes do SINÔNIMO (mesmo com code maior)', async () => {
    await inserir(13, 'ZQ21', 'zqwtieword alfa');
    await inserir(14, 'ZQ11', 'otro cuadro zqwnada');
    await pool.query(
      `INSERT INTO terminology.icd_synonyms (icd_uri, release, term, lang, created_by) VALUES ($1, $2, 'zqwtieword alfa', 'es', 'test-palavra')`,
      [URI(14), release],
    );

    // mesmo texto normalizado, mesma similaridade, ambos contêm a frase: só o desempate decide
    expect(await buscar('zqwtieword alfa')).toEqual(['ZQ21', 'ZQ11']);
  });

  it('ranking: frase inteira contida vem antes; depois similaridade; depois code', async () => {
    await inserir(7, 'ZQ09', 'zqwmental leve zqwretraso');
    await inserir(8, 'ZQ08', 'zqwretraso zqwmental leve');
    await inserir(9, 'ZQ07', 'zqwmental x zqwretraso x leve');

    // ZQ08 contém a frase "zqwretraso zqwmental leve"; os outros só casam as palavras.
    expect((await buscar('zqwretraso zqwmental leve'))[0]).toBe('ZQ08');
  });
});
