/**
 * 058b-ficha-vs-rota.e2e.test.ts @integration — spec 058 B1 (T222, SC-001 estendido, D-44): o MESMO serviço, lido pela FICHA (`GET /patients/:id`)
 * e pela ROTA (`GET /patients/:id/contracted-services`), devolve o ContractedServiceDetail INTEIRO idêntico — inclusive `schedule` e `authorization`,
 * que agora saem das mesmas funções (`fetchServiceSchedules`/`fetchCurrentAuthorizations`) com o mesmo `asOf`. Postgres real, app real, sem mock.
 */
import { Pool } from 'pg';
import type { AppDeFamilia } from './helpers/permissionFamilyHarness';
import { atorComCelulas, CELULAS_TODAS, chamar, fecharApp058a, limparAtores, subirApp058a } from './helpers/contrato058aApp';
import { criarPaciente, criarServico, DATABASE_URL, limpar, novoPool, PREFIXO_PACIENTE } from './helpers/contrato058aDb';

const ATOR = { uid: 'qa058b-fvr', nome: 'QA058B FVR' };

describe('058b ficha × rota — o ContractedServiceDetail inteiro @integration', () => {
  let pool: Pool;
  let app: AppDeFamilia;
  let patient = ''; let sA = ''; let sB = '';

  const apagarFilhos = async (): Promise<void> => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      const servicos = `SELECT id FROM patient_contracted_services WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE '${PREFIXO_PACIENTE}%')`;
      await c.query(`DELETE FROM contracted_service_authorization WHERE contracted_service_id IN (${servicos})`);
      await c.query(`DELETE FROM patient_itinerary_slot WHERE contracted_service_id IN (${servicos})`);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
  };

  beforeAll(async () => {
    pool = novoPool();
    await apagarFilhos();
    await limpar(pool);
    await limparAtores(pool, [ATOR]);
    await atorComCelulas(pool, ATOR.uid, ATOR.nome, CELULAS_TODAS);
    app = await subirApp058a(DATABASE_URL);
  }, 60000);

  beforeEach(async () => {
    await apagarFilhos();
    await limpar(pool);
    patient = await criarPaciente(pool, 'AR');
    sA = await criarServico(pool, patient);
    sB = await criarServico(pool, patient); // sem agenda e sem autorização
    await pool.query(`INSERT INTO contracted_service_authorization (contracted_service_id, hours, valid, recorded_by) VALUES ($1, 40, '[2020-01-01,2999-01-01)', 'qa058b')`, [sA]);
    await pool.query(
      `INSERT INTO patient_itinerary_slot (contracted_service_id, weekday, start_time, duration_minutes, valid, created_by, updated_by)
       VALUES ($1, 1, '08:00', 240, '[2020-01-01,)', 'qa058b', 'qa058b')`, [sA]);
  });

  afterAll(async () => {
    await apagarFilhos();
    await limpar(pool);
    await limparAtores(pool, [ATOR]);
    await fecharApp058a(app);
    await pool.end();
  });

  const porId = (itens: Array<{ id: string }>): Record<string, any> => Object.fromEntries(itens.map((i) => [i.id, i]));

  it('HTTP: ficha e rota devolvem o ContractedServiceDetail inteiro idêntico, serviço a serviço (com e sem agenda/autorização)', async () => {
    const f = await chamar(app, 'GET', `/api/admin/patients/${patient}`, ATOR.uid);
    const r = await chamar(app, 'GET', `/api/admin/patients/${patient}/contracted-services`, ATOR.uid);
    expect([f.status, r.status]).toEqual([200, 200]);
    const daFicha = porId(f.body.data.contractedServices);
    const daRota = porId(r.body.data.services);
    for (const id of [sA, sB]) {
      expect(daFicha[id]).toBeDefined();
      expect(daRota[id]).toEqual(daFicha[id]);
    }
    expect(daFicha[sA].authorization).toEqual({ id: expect.any(String), hours: 40, validFrom: '2020-01-01', validTo: '2998-12-31' });
    expect(daFicha[sA].schedule).toHaveLength(1);
    expect(daFicha[sA].schedule[0]).toMatchObject({ dayOfWeek: 1 });
    expect(daFicha[sB].schedule).toBeNull();
    expect(daFicha[sB].authorization).toBeNull();
  });
});
