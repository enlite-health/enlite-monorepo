/**
 * encuadre-move-role.integration.test.ts
 *
 * Feature "Equipe Armada": ao mover um card para SELECTED, o body pode carregar
 * `role` (TITULAR | RAPID_RESPONSE) e o backend grava em encuadres.role, que é a
 * base da classificação de equipe armada.
 *
 * Exercita o endpoint real PUT /api/admin/encuadres/:id/move com auth mock.
 * Ambiente: USE_MOCK_AUTH=true.
 *
 * ⚠️  ESCRITO MAS NÃO EXECUTADO nesta task — Postgres docker compartilhado.
 *     Rodar isolado com: npm run test:e2e:docker -- encuadre-move-role
 */

import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('PUT /encuadres/:id/move — captura de papel (SELECTED) @integration', () => {
  const api = createApiClient();
  let pool: Pool;
  let adminToken: string;
  const SUFFIX = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  let workerId: string;
  let jobPostingId: string;
  let encuadreId: string;

  beforeAll(async () => {
    await waitForBackend(api);
    pool = new Pool({ connectionString: DATABASE_URL });
    adminToken = await getMockToken(api, {
      uid: `role-admin-${SUFFIX}`,
      email: `role-admin-${SUFFIX}@e2e.local`,
      role: 'admin',
    });

    // Worker REGISTERED (elegível a mover — assertWorkerCanApply exige registro completo).
    const w = await pool.query<{ id: string }>(
      `INSERT INTO workers (auth_uid, email, status, country, timezone)
       VALUES ($1, $2, 'REGISTERED', 'AR', 'America/Argentina/Buenos_Aires') RETURNING id`,
      [`role-uid-${SUFFIX}`, `role-${SUFFIX}@e2e.local`],
    );
    workerId = w.rows[0].id;

    const jp = await pool.query<{ id: string }>(
      `INSERT INTO job_postings (title, status, is_draft, country, providers_needed)
       VALUES ($1, 'SEARCHING', false, 'AR', '1') RETURNING id`,
      [`Caso role ${SUFFIX}`],
    );
    jobPostingId = jp.rows[0].id;

    const e = await pool.query<{ id: string }>(
      `INSERT INTO encuadres (worker_id, job_posting_id, resultado, dedup_hash)
       VALUES ($1, $2, 'PENDIENTE', $3) RETURNING id`,
      [workerId, jobPostingId, `dedup-role-${SUFFIX}`],
    );
    encuadreId = e.rows[0].id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM encuadres WHERE job_posting_id = $1`, [jobPostingId]);
    await pool.query(`DELETE FROM worker_job_applications WHERE job_posting_id = $1`, [jobPostingId]);
    await pool.query(`DELETE FROM job_postings WHERE id = $1`, [jobPostingId]);
    await pool.query(`DELETE FROM workers WHERE id = $1`, [workerId]);
    await pool.end();
  });

  it('move SELECTED com role=TITULAR grava encuadres.role', async () => {
    const res = await api.put(
      `/api/admin/encuadres/${encuadreId}/move`,
      { targetStage: 'SELECTED', role: 'TITULAR' },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);

    const { rows } = await pool.query(
      `SELECT resultado, role FROM encuadres WHERE id = $1`,
      [encuadreId],
    );
    expect(rows[0].resultado).toBe('SELECCIONADO');
    expect(rows[0].role).toBe('TITULAR');
  });

  it('re-mover SELECTED sem role preserva o papel existente (COALESCE)', async () => {
    const res = await api.put(
      `/api/admin/encuadres/${encuadreId}/move`,
      { targetStage: 'SELECTED' },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(res.status).toBe(200);

    const { rows } = await pool.query(`SELECT role FROM encuadres WHERE id = $1`, [encuadreId]);
    expect(rows[0].role).toBe('TITULAR'); // não foi apagado
  });

  it('rejeita role inválido com 400', async () => {
    const res = await api.put(
      `/api/admin/encuadres/${encuadreId}/move`,
      { targetStage: 'SELECTED', role: 'SUPLENTE' },
      { headers: { Authorization: `Bearer ${adminToken}`, 'x-no-throw': '1' }, validateStatus: () => true },
    );
    expect(res.status).toBe(400);
  });
});
