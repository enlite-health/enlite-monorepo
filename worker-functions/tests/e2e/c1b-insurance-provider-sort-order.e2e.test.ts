/**
 * c1b-insurance-provider-sort-order.e2e.test.ts @integration — C6 do relatório F5.
 *
 * `insurance_providers` tem DUAS restrições únicas (migration 311): a PK `code` e
 * `insurance_providers_sort_order_unico UNIQUE (sort_order)`. O repositório mapeava QUALQUER
 * 23505 para `InsuranceProviderExistsError(code)` — então um POST com `sortOrder` já usado
 * respondia "esse código já existe" para um código que NÃO existe, e o admin desistia de cadastrar
 * uma cobertura que o catálogo não tem.
 *
 * Postgres real, porque a prova é justamente QUAL restrição o banco violou.
 */
import { Pool } from 'pg';
import { InsuranceProviderRepository, InsuranceProviderExistsError } from '@modules/case/infrastructure/InsuranceProviderRepository';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const SORT = 9911;
const CODE_A = 'C1B_COBERTURA_A';
const CODE_B = 'C1B_COBERTURA_B';

describe('C6 — 23505 de `sort_order` não vira "código já existe" (Postgres real) @integration', () => {
  let pool: Pool;
  const repo = new InsuranceProviderRepository();

  const limpar = async (): Promise<void> => {
    await pool.query(`DELETE FROM insurance_provider_aliases WHERE code LIKE 'C1B\\_%'`);
    await pool.query(`DELETE FROM insurance_providers WHERE code LIKE 'C1B\\_%'`);
  };

  beforeAll(async () => { pool = new Pool({ connectionString: DATABASE_URL }); await limpar(); });
  afterAll(async () => { await limpar(); await pool.end(); });

  it('a. controle positivo: as duas restrições existem na tabela', async () => {
    const { rows } = await pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'insurance_providers'::regclass AND contype IN ('p','u') ORDER BY conname`,
    );
    expect(rows.map((r) => r.conname)).toEqual(expect.arrayContaining(['insurance_providers_pkey', 'insurance_providers_sort_order_unico']));
  });

  it('b. `sortOrder` já usado por OUTRO código → erro de SORT ORDER, nunca "código já existe"', async () => {
    await repo.create({ code: CODE_A, sortOrder: SORT });
    const err = await repo.create({ code: CODE_B, sortOrder: SORT }).catch((e) => e);

    expect(err).not.toBeInstanceOf(InsuranceProviderExistsError);
    expect((err as { code?: string }).code).toBe('INSURANCE_PROVIDER_SORT_ORDER_TAKEN');
    expect((err as { sortOrder?: number }).sortOrder).toBe(SORT);
    expect((err as Error).message).not.toMatch(new RegExp(CODE_B));
    // e o código que NÃO existe continua não existindo (o admin não foi mandado embora à toa)
    const { rows } = await pool.query(`SELECT 1 FROM insurance_providers WHERE code = $1`, [CODE_B]);
    expect(rows).toHaveLength(0);
  });

  it('c. código repetido continua sendo `InsuranceProviderExistsError` (controle positivo da outra restrição)', async () => {
    const err = await repo.create({ code: CODE_A, sortOrder: SORT + 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(InsuranceProviderExistsError);
    expect((err as InsuranceProviderExistsError).providerCode).toBe(CODE_A);
  });
});
