/**
 * admin-vacancies-list-counters.test.ts
 *
 * Valida que os contadores "selecionados" e "confirmados" da listagem
 * GET /api/admin/vacancies contam apenas os workers que estão nas colunas
 * SELECTED e CONFIRMED do kanban, respectivamente — não os 3 stages
 * agregados em PRE_SELECTED_STAGES (que ainda é usado pelo detalhe).
 * PLACED foi removido do CHECK em F7.a (migration 194).
 */

import { Pool } from 'pg';
import { createApiClient, createPatientFixture, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('GET /api/admin/vacancies — contador selecionados', () => {
  const api = createApiClient();
  let adminToken: string;
  let pool: Pool;
  let patientId: string;
  let vacancyId: string;
  const uniqueCaseNumber = 99980;

  beforeAll(async () => {
    await waitForBackend(api);
    adminToken = await getMockToken(api, {
      uid: 'list-counters-admin',
      email: 'list-counters-admin@e2e.local',
      role: 'admin',
    });
    pool = new Pool({ connectionString: DATABASE_URL });
    patientId = await createPatientFixture(pool, 'list-counters');

    const vacancy = await pool.query(
      `INSERT INTO job_postings (title, description, country, status, patient_id, case_number, providers_needed)
       VALUES ('Caso E2E counter', 'desc', 'AR', 'SEARCHING', $1, $2, '4')
       RETURNING id`,
      [patientId, uniqueCaseNumber],
    );
    vacancyId = vacancy.rows[0].id as string;

    const stages = ['SELECTED', 'QUALIFIED', 'CONFIRMED'];
    for (const stage of stages) {
      const suffix = `${stage.toLowerCase()}-${Date.now()}`;
      const w = await pool.query(
        `INSERT INTO workers (auth_uid, email, country, timezone, status)
         VALUES ($1, $2, 'AR', 'America/Argentina/Buenos_Aires', 'REGISTERED')
         RETURNING id`,
        [`uid-${suffix}`, `worker-${suffix}@counters.test`],
      );
      await pool.query(
        `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage)
         VALUES ($1, $2, $3)`,
        [w.rows[0].id, vacancyId, stage],
      );
    }
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(`DELETE FROM worker_job_applications WHERE job_posting_id = $1`, [vacancyId]);
      await pool.query(`DELETE FROM workers WHERE email LIKE '%@counters.test'`);
      await pool.query(`DELETE FROM job_postings WHERE id = $1`, [vacancyId]);
      await pool.query(`DELETE FROM patients WHERE id = $1`, [patientId]);
      await pool.end();
    }
  });

  it('selecionados conta só SELECTED (não QUALIFIED nem CONFIRMED)', async () => {
    const res = await api.get(
      `/api/admin/vacancies?search=${uniqueCaseNumber}`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(res.status).toBe(200);
    const row = res.data.data.find((v: { id: string }) => v.id === vacancyId);
    expect(row).toBeDefined();
    expect(row.selecionados).toBe('01');
  });

  it('confirmados conta só CONFIRMED (mesma semântica da coluna do kanban)', async () => {
    const res = await api.get(
      `/api/admin/vacancies?search=${uniqueCaseNumber}`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(res.status).toBe(200);
    const row = res.data.data.find((v: { id: string }) => v.id === vacancyId);
    expect(row).toBeDefined();
    expect(row.confirmados).toBe('01');
  });

  it('faltantes desconta apenas os de SELECTED do providers_needed', async () => {
    const res = await api.get(
      `/api/admin/vacancies?search=${uniqueCaseNumber}`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    const row = res.data.data.find((v: { id: string }) => v.id === vacancyId);
    expect(row.faltantes).toBe('03');
  });
});
