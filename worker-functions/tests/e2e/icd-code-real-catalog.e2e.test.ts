/**
 * F1-CORREÇÃO D7 — a régua do critério de aceite 7: "valide contra os 35.692 códigos reais do
 * catálogo para não rejeitar nenhum válido (rode essa verificação e cole o número de rejeitados:
 * tem de ser 0)". Este arquivo é essa verificação, automatizada — roda contra o Postgres real
 * (release '2026-01', ingerido por scripts/ingest-icd11-catalog.ts), não uma amostra.
 */
import { Pool } from 'pg';
import { IcdCode, InvalidIcdCodeError } from '../../src/modules/terminology/domain/IcdCode';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('IcdCode.parse — validado contra o catálogo REAL (D7)', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('0 dos 35.692 códigos reais do release 2026-01 são rejeitados', async () => {
    const { rows } = await pool.query<{ code: string }>(
      `SELECT code FROM terminology.icd_entities WHERE release = '2026-01'`,
    );
    expect(rows.length).toBeGreaterThan(30000); // guarda contra catálogo vazio/parcial mascarando "0 rejeitados"

    const rejected: string[] = [];
    for (const { code } of rows) {
      try {
        IcdCode.parse(code);
      } catch (err) {
        if (err instanceof InvalidIcdCodeError) rejected.push(code);
        else throw err;
      }
    }

    if (rejected.length > 0) {
      // eslint-disable-next-line no-console
      console.error(`IcdCode rejeitou ${rejected.length} códigos reais — amostra:`, rejected.slice(0, 20));
    }
    expect(rejected).toHaveLength(0);
    expect(rows.length).toBe(35692);
  });

  it('o código truncado do defeito da F0 ("02.Z") NÃO existe no catálogo real — a rejeição do VO nunca bate em dado de produção', async () => {
    const { rows } = await pool.query(`SELECT 1 FROM terminology.icd_entities WHERE release = '2026-01' AND code = '02.Z'`);
    expect(rows).toHaveLength(0);
  });
});
