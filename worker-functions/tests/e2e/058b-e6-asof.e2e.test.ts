/** 058b-e6-asof.e2e.test.ts @integration — spec 058 B1 (E6): autorização (e agenda, B1-BE-06) pelo "hoje" do PAÍS, requestNow FIXO e no passado
 *  distante (determinístico). 2024-03-10T01:00Z = 22:00 de 09/03 em Buenos Aires. Postgres real, sem mock de módulo. */
import { Pool } from 'pg';
import { criarPaciente, criarServico, DATABASE_URL, limpar, novoPool, PREFIXO_PACIENTE } from './helpers/contrato058aDb';

const AGORA = new Date('2024-03-10T01:00:00Z');

describe('058b E6 — autorização e agenda pelo asOf do país @integration', () => {
  let pool: Pool; let patient = ''; let service = '';
  let repo: { listForPatient(p: string, now: Date): Promise<Array<Record<string, any>>> };

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
    process.env.DATABASE_URL = DATABASE_URL;
    pool = novoPool();
    const { PatientContractedServiceRepository } = await import('@modules/case/infrastructure/PatientContractedServiceRepository');
    repo = new PatientContractedServiceRepository() as unknown as typeof repo;
  }, 60000);
  beforeEach(async () => { await apagarFilhos(); await limpar(pool); patient = await criarPaciente(pool, 'AR'); service = await criarServico(pool, patient); });
  afterAll(async () => {
    await apagarFilhos(); await limpar(pool); await pool.end();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
  });

  it('E6 asOf: [2024-03-09, 2024-03-10) aparece às 22h de 09/03 em AR e já não aparece em 10/03 ao meio-dia', async () => {
    await pool.query(`INSERT INTO contracted_service_authorization (contracted_service_id, hours, valid, recorded_by) VALUES ($1, 10, '[2024-03-09,2024-03-10)', 'qa058b')`, [service]);
    const [svc] = await repo.listForPatient(patient, AGORA);
    expect(svc.authorization).toEqual({ id: expect.any(String), hours: 10, validFrom: '2024-03-09', validTo: '2024-03-09' });
    const [depois] = await repo.listForPatient(patient, new Date('2024-03-10T12:00:00Z'));
    expect(depois.authorization).toBeNull();
  });
});
