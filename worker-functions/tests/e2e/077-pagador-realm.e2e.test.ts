/**
 * 077-pagador-realm.e2e.test.ts @integration — spec 077 (D672; migrations 584 e 585): trava de MÃO ÚNICA do pagador de teste.
 * Pagador/contrato de teste só em paciente/serviço de teste; pagador real em qualquer paciente, inclusive o de teste.
 * A trava mora no banco (`fn_077_payer_realm_matches_patient`, corpo de mão única desde a 585, lida por `trg_077_piv_test_realm`,
 * `trg_077_csc_test_realm` e pelo PUT de cobertura): o SQL direto prova que todo escritor das 2 junções passa por ela; as rotas
 * reais provam o status (PUT de cobertura 422 INSURANCE_PROVIDER_UNKNOWN, vínculo 422 TEST_REALM_MISMATCH).
 * Casos: (1) teste em real -> recusa; (2) real em teste -> aceito; (3) teste em teste -> aceito; (4) real em real -> aceito.
 * Cada caso tem paciente e serviço próprios (a T2 da 537 recusaria 2 pagadores vivos no mesmo paciente: TWO_PAYERS_OVERLAP).
 * Postgres e API reais. Fixtures e limpeza das suítes 058a (`QA058_`, `T058A-`).
 */
import { Pool } from 'pg';
import { criarContrato, criarPagador, criarPaciente, criarServico, erroDe, limpar, novoPool, vigencia, vincular } from './helpers/contrato058aDb';
import { api, atores, BASE } from './helpers/contrato058aApi';
import type { StaffAuth } from './helpers/staffAuth';

describe('077 trava de mão única do pagador de teste @integration', () => {
  let pool: Pool;
  let admin: StaffAuth;
  let pagReal = ''; let pagTeste = '';
  let ctReal = ''; let ctTeste = '';

  const limparCobertura = (): Promise<unknown> =>
    pool.query(`DELETE FROM patient_insurance_verified WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE 'T058A-%')`);
  const cobertura = (pac: string, ordinal: number, code: string): Promise<unknown> =>
    pool.query(`INSERT INTO patient_insurance_verified (patient_id, ordinal, raw_label, source, provider_code) VALUES ($1, $2, $3, 'admin_manual', $3)`, [pac, ordinal, code]);
  const paciente = async (teste: boolean): Promise<{ pac: string; sv: string }> => {
    const pac = await criarPaciente(pool, 'AR');
    if (teste) await pool.query('UPDATE patients SET is_test = true WHERE id = $1', [pac]);
    return { pac, sv: await criarServico(pool, pac) };
  };
  const coberturas = async (pac: string): Promise<number> =>
    (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM patient_insurance_verified WHERE patient_id = $1', [pac])).rows[0].n;
  const vinculos = async (sv: string): Promise<number> =>
    (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM contracted_service_contract WHERE contracted_service_id = $1', [sv])).rows[0].n;
  const aceito = async (teste: boolean, pag: string, ct: string): Promise<void> => {
    const { pac, sv } = await paciente(teste);
    expect(await erroDe(() => cobertura(pac, 1, pag))).toBeNull();
    expect(await erroDe(() => vincular(pool, sv, ct, vigencia('2026-11-01')))).toBeNull();
    expect((await api.patch(`${BASE}/patients/${pac}/coverage`, { insuranceVerifiedCodes: [pag] }, admin)).status).toBe(200);
    expect(await vinculos(sv)).toBe(1);
    expect(await coberturas(pac)).toBe(1);
  };

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
  });
  afterAll(async () => { await limparCobertura(); await limpar(pool); await pool.end(); });

  it('T-F2a-86 (1) banco: pagador de teste em paciente real e contrato de teste em serviço real → P0001 TEST_REALM_MISMATCH', async () => {
    const { pac, sv } = await paciente(false);
    expect(await erroDe(() => cobertura(pac, 2, pagReal))).toBeNull();
    const recusas = [
      await erroDe(() => cobertura(pac, 1, pagTeste)),
      await erroDe(() => pool.query('UPDATE patient_insurance_verified SET provider_code = $2 WHERE patient_id = $1 AND ordinal = 2', [pac, pagTeste])),
      await erroDe(() => vincular(pool, sv, ctTeste, vigencia('2026-11-01'))),
    ];
    expect(recusas.map((e) => `${e?.code}:${e?.message}`)).toEqual(Array(3).fill('P0001:TEST_REALM_MISMATCH'));
    expect(await vinculos(sv)).toBe(0);
  });

  it('T-F2a-86 (1) PUT de cobertura: paciente real com o pagador de teste → 422 INSURANCE_PROVIDER_UNKNOWN, nada gravado', async () => {
    const { pac } = await paciente(false);
    const r = await api.patch(`${BASE}/patients/${pac}/coverage`, { insuranceVerifiedCodes: [pagTeste] }, admin);
    expect(r.status).toBe(422);
    expect(r.data.code).toBe('INSURANCE_PROVIDER_UNKNOWN');
    expect(await coberturas(pac)).toBe(0);
  });

  it('T-F2a-86 (1) vínculo pela rota: serviço real com contrato do pagador de teste → 422 TEST_REALM_MISMATCH, nada gravado', async () => {
    const { pac, sv } = await paciente(false);
    const r = await api.post(`${BASE}/patients/${pac}/contracted-services/${sv}/contract-link`, { contractId: ctTeste, validFrom: '2026-11-01' }, admin);
    expect(r.status).toBe(422);
    expect(r.data.code).toBe('TEST_REALM_MISMATCH');
    expect(await vinculos(sv)).toBe(0);
  });

  it('T-F2a-86 (2) pagador real em paciente de teste → aceito (cobertura, vínculo e PUT 200; D672)', async () => {
    await aceito(true, pagReal, ctReal);
  });

  it('T-F2a-86 (3) pagador de teste em paciente de teste → aceito (cobertura, vínculo e PUT 200)', async () => {
    await aceito(true, pagTeste, ctTeste);
  });

  it('T-F2a-86 (4) pagador real em paciente real → aceito (cobertura, vínculo e PUT 200)', async () => {
    await aceito(false, pagReal, ctReal);
  });
});
