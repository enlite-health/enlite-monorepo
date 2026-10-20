/**
 * 058a-nome-repetido.e2e.test.ts @integration — criar obra social com NOME repetido responde 409 de NOME, não de código.
 * Sem `code`, o código é derivado do nome: o INSERT batia no pkey antes do `insurance_providers_name_uq` e a tela oferecia código manual.
 * Rotas reais + Postgres real.
 */
import { Pool } from 'pg';
import { limpar, novoPool } from './helpers/contrato058aDb';
import { api, atores, BASE, sufixo } from './helpers/contrato058aApi';
import type { StaffAuth } from './helpers/staffAuth';

describe('058a nome repetido de obra social @integration', () => {
  let pool: Pool;
  let admin: StaffAuth;
  beforeAll(async () => { pool = novoPool(); await limpar(pool); ({ admin } = await atores()); });
  afterAll(async () => { await limpar(pool); await pool.end(); });

  it('nome repetido (caixa e espaços diferentes) → 409 INSURANCE_PROVIDER_NAME_EXISTS, nunca CODE_EXISTS, e nada novo é gravado', async () => {
    const nome = `QA058 Nome Repetido ${sufixo()}`;
    const criada = await api.post(`${BASE}/catalogs/insurance-providers`, { name: nome }, admin);
    expect(criada.status).toBe(201);
    const antes = Number((await pool.query('SELECT count(*) FROM insurance_providers')).rows[0].count);

    for (const variante of [nome, `  ${nome.toUpperCase()}  `, nome.toLowerCase()]) {
      const dup = await api.post(`${BASE}/catalogs/insurance-providers`, { name: variante }, admin);
      expect(dup.status).toBe(409);
      expect(dup.data.code).toBe('INSURANCE_PROVIDER_NAME_EXISTS');
    }
    expect(Number((await pool.query('SELECT count(*) FROM insurance_providers')).rows[0].count)).toBe(antes);
  });
});
