/**
 * 077-pagador-realm.e2e.test.ts @integration — spec 077 (D671; migration 584): pagador e paciente no MESMO realm (is_test).
 * O guard mora no banco (`fn_077_payer_realm_matches_patient` + `trg_077_piv_test_realm` + `trg_077_csc_test_realm`): o SQL direto
 * prova que todo escritor das 2 junções passa por ele; as rotas reais provam o status (PUT de cobertura 422 INSURANCE_PROVIDER_UNKNOWN,
 * vínculo 422 TEST_REALM_MISMATCH). Postgres e API reais. Fixtures e limpeza das suítes 058a (`QA058_`, `T058A-`).
 */
import { Pool } from 'pg';
import { criarContrato, criarPagador, criarPaciente, criarServico, erroDe, limpar, novoPool, vigencia, vincular } from './helpers/contrato058aDb';
import { api, atores, BASE } from './helpers/contrato058aApi';
import type { StaffAuth } from './helpers/staffAuth';

describe('077 guard de realm do pagador de teste @integration', () => {
  let pool: Pool;
  let admin: StaffAuth;
  let pagReal = ''; let pagTeste = '';
  let ctReal = ''; let ctTeste = '';
  let pacReal = ''; let pacTeste = '';
  let svReal = ''; let svTeste = '';

  const limparCobertura = (): Promise<unknown> =>
    pool.query(`DELETE FROM patient_insurance_verified WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE 'T058A-%')`);

  beforeAll(async () => {
    pool = novoPool();
    await limparCobertura();
    await limpar(pool);
    ({ admin } = await atores());
    pagReal = await criarPagador(pool, 'PREPAGA');
    pagTeste = await criarPagador(pool, 'PREPAGA');
    await pool.query('UPDATE insurance_providers SET is_test = true WHERE code = $1', [pagTeste]);
    ctReal = await criarContrato(pool, pagReal);
    ctTeste = await criarContrato(pool, pagTeste);
    pacReal = await criarPaciente(pool, 'AR');
    pacTeste = await criarPaciente(pool, 'AR');
    await pool.query('UPDATE patients SET is_test = true WHERE id = $1', [pacTeste]);
    svReal = await criarServico(pool, pacReal);
    svTeste = await criarServico(pool, pacTeste);
  });
  afterAll(async () => { await limparCobertura(); await limpar(pool); await pool.end(); });

  it('T-F2a-85 banco: as 2 junções recusam realm cruzado nos dois sentidos (P0001 TEST_REALM_MISMATCH) e aceitam o mesmo realm', async () => {
    const cobertura = (pac: string, code: string): Promise<unknown> =>
      pool.query(`INSERT INTO patient_insurance_verified (patient_id, ordinal, raw_label, source, provider_code) VALUES ($1, 1, $2, 'admin_manual', $2)`, [pac, code]);
    const recusas = [
      await erroDe(() => cobertura(pacReal, pagTeste)),
      await erroDe(() => cobertura(pacTeste, pagReal)),
      await erroDe(() => vincular(pool, svReal, ctTeste, vigencia('2026-11-01'))),
      await erroDe(() => vincular(pool, svTeste, ctReal, vigencia('2026-11-01'))),
    ];
    expect(recusas.map((e) => `${e?.code}:${e?.message}`)).toEqual(Array(4).fill('P0001:TEST_REALM_MISMATCH'));
    expect(await erroDe(() => vincular(pool, svTeste, ctTeste, vigencia('2026-11-01')))).toBeNull();
    expect(await erroDe(() => vincular(pool, svReal, ctReal, vigencia('2026-11-01')))).toBeNull();
  });

  it('T-F2a-85 PUT de cobertura: paciente real com o pagador de teste → 422 INSURANCE_PROVIDER_UNKNOWN, nada gravado; paciente de teste com ele → 200', async () => {
    const r = await api.patch(`${BASE}/patients/${pacReal}/coverage`, { insuranceVerifiedCodes: [pagTeste] }, admin);
    expect(r.status).toBe(422);
    expect(r.data.code).toBe('INSURANCE_PROVIDER_UNKNOWN');
    const n = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM patient_insurance_verified WHERE patient_id = $1', [pacReal]);
    expect(n.rows[0].n).toBe(0);
    expect((await api.patch(`${BASE}/patients/${pacTeste}/coverage`, { insuranceVerifiedCodes: [pagTeste] }, admin)).status).toBe(200);
  });

  it('T-F2a-85 vínculo pela rota: serviço real com contrato do pagador de teste → 422 TEST_REALM_MISMATCH, nada gravado', async () => {
    // paciente real NOVO: o do 1º caso já tem vínculo vivo com o pagador real (a T2 da 537 recusaria antes por TWO_PAYERS_OVERLAP)
    const pac = await criarPaciente(pool, 'AR');
    const sv = await criarServico(pool, pac);
    const r = await api.post(`${BASE}/patients/${pac}/contracted-services/${sv}/contract-link`, { contractId: ctTeste, validFrom: '2026-11-01' }, admin);
    expect(r.status).toBe(422);
    expect(r.data.code).toBe('TEST_REALM_MISMATCH');
    const n = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM contracted_service_contract WHERE contracted_service_id = $1', [sv]);
    expect(n.rows[0].n).toBe(0);
  });
});
