/**
 * 077-pagador-de-teste.e2e.test.ts @integration — spec 077 (D669 DP-15, D665): o pagador de teste (`insurance_providers.is_test`)
 * fica fora das 3 listas do catálogo (select do drawer de cobertura, página de obras sociais, cascata do serviço) e segue
 * legível por código e como `selected` da cascata. Rotas reais + Postgres real. Fixtures e limpeza das suítes 058a (`QA058_`).
 */
import { Pool } from 'pg';
import { criarContrato, criarPagador, limpar, novoPool } from './helpers/contrato058aDb';
import { api, atores, BASE } from './helpers/contrato058aApi';
import type { StaffAuth } from './helpers/staffAuth';

const codigos = (xs: Array<{ code: string }>): string[] => xs.map((x) => x.code);

describe('077 pagador de teste fora das listas do catálogo @integration', () => {
  let pool: Pool;
  let admin: StaffAuth;
  let real: string;
  let teste: string;

  beforeAll(async () => {
    pool = novoPool();
    await limpar(pool);
    ({ admin } = await atores());
    real = await criarPagador(pool);
    teste = await criarPagador(pool);
    await pool.query('UPDATE insurance_providers SET is_test = true WHERE code = $1', [teste]);
    await criarContrato(pool, real);
    await criarContrato(pool, teste);
  });
  afterAll(async () => { await limpar(pool); await pool.end(); });

  it('T-F2a-81 select do drawer de cobertura: o real aparece, o de teste não', async () => {
    const r = await api.get(`${BASE}/catalogs/insurance-providers`, admin);
    expect(r.status).toBe(200);
    expect(codigos(r.data.data.providers)).toContain(real);
    expect(codigos(r.data.data.providers)).not.toContain(teste);
  });

  it('T-F2a-81 página de obras sociais, com e sem as inativas: o real aparece, o de teste não', async () => {
    for (const q of ['', '?includeInactive=true']) {
      const r = await api.get(`${BASE}/insurance-providers${q}`, admin);
      expect(r.status).toBe(200);
      expect(codigos(r.data.data.items)).toContain(real);
      expect(codigos(r.data.data.items)).not.toContain(teste);
    }
  });

  it('T-F2a-81 cascata do serviço: o de teste some da oferta e segue como selected e no detalhe por código', async () => {
    const r = await api.get(`${BASE}/insurance-providers/for-service?country=AR`, admin);
    expect(r.status).toBe(200);
    expect(codigos(r.data.data.providers)).toContain(real);
    expect(codigos(r.data.data.providers)).not.toContain(teste);
    const sel = await api.get(`${BASE}/insurance-providers/for-service?country=AR&selected=${teste}`, admin);
    expect(codigos(sel.data.data.providers)).toContain(teste);
    expect((await api.get(`${BASE}/insurance-providers/${teste}`, admin)).status).toBe(200);
  });
});
