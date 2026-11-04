/** 058b-autorizacao-ordem.e2e.test.ts @integration — spec 058 B1 (T224): `list` ordena por `valid DESC, recorded_at DESC` — início igual
 *  desempata pelo FIM antes do registro. Postgres real, sem mock de módulo. */
import { Pool } from 'pg';
import { criarPaciente, criarServico, DATABASE_URL, limpar, novoPool, PREFIXO_PACIENTE } from './helpers/contrato058aDb';

describe('058b autorização — ordem com início igual @integration', () => {
  let pool: Pool; let patient = ''; let service = '';

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
  }, 60000);
  beforeEach(async () => { await apagarFilhos(); await limpar(pool); patient = await criarPaciente(pool, 'AR'); service = await criarServico(pool, patient); });
  afterAll(async () => {
    await apagarFilhos(); await limpar(pool); await pool.end();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
  });

  it('ordem: dois registros de mesmo início — vence o de fim MAIOR (valid DESC), mesmo que o outro tenha sido gravado depois', async () => {
    // A: [2026-01-01,2027-01-01), gravada 1º e corrigida (superseded) · B: [2026-01-01,2026-07-01), corrente, gravada depois. EXCLUDE só vê as correntes.
    const a = await pool.query<{ id: string }>(`INSERT INTO contracted_service_authorization (contracted_service_id, hours, valid, recorded_by) VALUES ($1, 10, '[2026-01-01,2027-01-01)', 'qa058b') RETURNING id`, [service]);
    await pool.query(`UPDATE contracted_service_authorization SET superseded_at = now() WHERE id = $1`, [a.rows[0].id]);
    await pool.query(`INSERT INTO contracted_service_authorization (contracted_service_id, hours, valid, recorded_by) VALUES ($1, 20, '[2026-01-01,2026-07-01)', 'qa058b')`, [service]);
    const { ContractedServiceAuthorizationRepository } = await import('@modules/case/infrastructure/ContractedServiceAuthorizationRepository');
    const linhas = await new ContractedServiceAuthorizationRepository().list(service);
    expect(linhas.map((l) => l.hours)).toEqual([10, 20]);
  });
});
