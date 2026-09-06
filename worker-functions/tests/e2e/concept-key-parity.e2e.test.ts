/**
 * 🔧 F5-CORREÇÃO T2 (QA-caça, 05/09/2026) — PARIDADE entre as duas encarnações da regra de
 * identidade de conceito.
 *
 * A regra vive na função SQL `terminology.concept_key` (migration 328), que também alimenta a
 * coluna GERADA `icd_entities.concept_key` e é chamada pelo adaptador real dentro do próprio SQL.
 * O TypeScript tem um espelho (`src/modules/terminology/infrastructure/conceptKey.ts`) por um
 * motivo só: o fake (`InMemoryTerminology`) não tem Postgres para chamar.
 *
 * Duas encarnações de uma regra é exatamente o tipo de coisa que diverge em silêncio. Este teste
 * é o instrumento que impede: roda as DUAS sobre URIs REAIS do catálogo (não fixtures escolhidas
 * por mim, que confirmariam a minha própria suposição — D187) e exige igualdade.
 *
 * Postgres real, somente LEITURA — não escreve nada.
 */
import { Pool } from 'pg';
import { conceptKey } from '../../src/modules/terminology/infrastructure/conceptKey';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('T2 — conceptKey (TS) e terminology.concept_key (SQL) são a MESMA regra @integration', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('a coluna GERADA existe e é de fato gerada (não uma coluna comum que alguém preenche)', async () => {
    const { rows } = await pool.query<{ is_generated: string; generation_expression: string }>(
      `SELECT is_generated, generation_expression FROM information_schema.columns
        WHERE table_schema = 'terminology' AND table_name = 'icd_entities' AND column_name = 'concept_key'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].is_generated).toBe('ALWAYS');
    expect(rows[0].generation_expression).toContain('concept_key');
  });

  it('as duas implementações concordam sobre 500 URIs REAIS do catálogo (amostra aleatória)', async () => {
    const { rows } = await pool.query<{ icd_uri: string; concept_key: string }>(
      `SELECT icd_uri, concept_key FROM terminology.icd_entities ORDER BY random() LIMIT 500`,
    );
    // Contagem zero é falha, nunca sucesso: sem linhas, este teste não mediu nada.
    expect(rows.length).toBe(500);

    const divergentes = rows.filter((r) => conceptKey(r.icd_uri) !== r.concept_key);
    expect(divergentes).toEqual([]);
  });

  it('a chave é ÚNICA por release no catálogo real — a invariante que o índice da 328 declara', async () => {
    const { rows } = await pool.query<{ total: string; distintas: string }>(
      `SELECT count(*)::text AS total, count(DISTINCT concept_key)::text AS distintas
         FROM terminology.icd_entities WHERE release = (SELECT release FROM terminology.icd_releases WHERE is_current)`,
    );
    expect(Number(rows[0].total)).toBeGreaterThan(0);
    expect(rows[0].distintas).toBe(rows[0].total);
  });

  it('controle NEGATIVO: uma URI inventada com outro id dá chave DIFERENTE nos dois lados', async () => {
    const inventada = 'http://id.who.int/icd/release/11/2026-01/mms/000000000';
    const { rows } = await pool.query<{ k: string }>(`SELECT terminology.concept_key($1) AS k`, [inventada]);
    expect(conceptKey(inventada)).toBe(rows[0].k);
    expect(rows[0].k).toBe('mms/000000000');
  });

  it('o mapa REAL do ClickUp (migration 327) tem chave resolvível — todas as 8 URIs batem no catálogo corrente', async () => {
    const { rows } = await pool.query<{ label: string; resolve: boolean }>(
      `SELECT m.label,
              EXISTS (SELECT 1 FROM terminology.icd_entities e
                       WHERE e.release = (SELECT release FROM terminology.icd_releases WHERE is_current)
                         AND e.concept_key = terminology.concept_key(m.concept_uri)) AS resolve
         FROM clickup_diagnosis_labels m WHERE m.active`,
    );
    expect(rows.length).toBeGreaterThan(0); // contagem zero seria "não olhei"
    expect(rows.filter((r) => !r.resolve)).toEqual([]);
  });
});
