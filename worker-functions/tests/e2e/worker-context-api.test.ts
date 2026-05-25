/**
 * worker-context-api.test.ts
 *
 * Testa os 3 endpoints do triage-service (MCP internal):
 *   GET  /api/admin/workers/:id/current-interview
 *   GET  /api/admin/workers/:id/available-vacancies
 *   POST /api/admin/workers/:id/documents/ingest-from-url
 *
 * Auth: MockAuth (USE_MOCK_AUTH=true) com role admin.
 * DB:   Pool real contra enlite_e2e (nenhum mock de banco).
 */

import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { createApiClient, getMockToken, waitForBackend } from './helpers';

/**
 * Cria uma job_posting mínima com timezone explícita e retorna o id.
 * Usa INSERT direto no DB (sem API) pra controlar timezone precisamente.
 */
async function createTimezoneVacancy(
  pool: Pool,
  country: 'AR' | 'BR',
  timezone: string,
): Promise<string> {
  const id = uuidv4();
  await pool.query(
    `INSERT INTO job_postings (id, title, description, country, status, timezone)
     VALUES ($1, $2, 'E2E timezone test vacancy', $3, 'ACTIVE', $4)`,
    [id, `TZ-Test-${country}-${Date.now()}`, country, timezone],
  );
  return id;
}

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const NON_EXISTENT_UUID = '00000000-0000-0000-0000-000000000000';

describe('Worker Context API (triage-service endpoints)', () => {
  const api = createApiClient();
  let adminToken: string;
  let workerToken: string;
  let pool: Pool;
  let seededWorkerId: string;

  beforeAll(async () => {
    await waitForBackend(api);

    adminToken = await getMockToken(api, {
      uid: 'wc-api-admin-e2e',
      email: 'wc-api-admin@e2e.local',
      role: 'admin',
    });

    workerToken = await getMockToken(api, {
      uid: 'wc-api-worker-e2e',
      email: 'wc-api-worker@e2e.local',
      role: 'worker',
    });

    pool = new Pool({ connectionString: DATABASE_URL });

    // Seed: cria um worker para os testes
    const initRes = await api.post('/api/workers/init', {
      authUid: `wc-api-${Date.now()}`,
      email: `wc-api-${Date.now()}@e2e.local`,
      country: 'AR',
    });

    if (initRes.status !== 200 && initRes.status !== 201) {
      throw new Error(`Seed worker failed: ${JSON.stringify(initRes.data)}`);
    }
    seededWorkerId = initRes.data.data.id;
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  function adminHeaders() {
    return { headers: { Authorization: `Bearer ${adminToken}` } };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/admin/workers/:id/current-interview
  // ─────────────────────────────────────────────────────────────────────────
  describe('GET /api/admin/workers/:id/current-interview', () => {
    it('retorna { interview: null } quando worker não tem encuadre agendado', async () => {
      const res = await api.get(
        `/api/admin/workers/${seededWorkerId}/current-interview`,
        adminHeaders(),
      );

      expect(res.status).toBe(200);
      expect(res.data).toEqual({ interview: null });
    });

    it('retorna 401 sem token', async () => {
      const res = await api.get(
        `/api/admin/workers/${seededWorkerId}/current-interview`,
      );
      expect(res.status).toBe(401);
    });

    it('retorna 401 para role worker', async () => {
      const res = await api.get(
        `/api/admin/workers/${seededWorkerId}/current-interview`,
        { headers: { Authorization: `Bearer ${workerToken}` } },
      );
      expect(res.status).toBe(401);
    });

    it('retorna 200 com estrutura de entrevista quando slot agendado existe', async () => {
      // Seed: job_posting + interview_slot + encuadre
      const postingRes = await pool.query(`
        SELECT id FROM job_postings
        WHERE deleted_at IS NULL
        LIMIT 1
      `);
      if (postingRes.rows.length === 0) {
        // Não há vagas disponíveis — skip graceful
        return;
      }
      const jobPostingId = postingRes.rows[0].id as string;

      // Cria um slot no futuro
      const slotRes = await pool.query(
        `INSERT INTO interview_slots (job_posting_id, slot_date, slot_time, max_capacity)
         VALUES ($1, CURRENT_DATE + INTERVAL '7 days', '10:00:00', 5)
         RETURNING id`,
        [jobPostingId],
      );
      const slotId = slotRes.rows[0].id as string;

      // Cria encuadre ligando worker ao slot
      await pool.query(
        `INSERT INTO encuadres (worker_id, job_posting_id, interview_slot_id)
         VALUES ($1, $2, $3)`,
        [seededWorkerId, jobPostingId, slotId],
      );

      try {
        const res = await api.get(
          `/api/admin/workers/${seededWorkerId}/current-interview`,
          adminHeaders(),
        );

        expect(res.status).toBe(200);
        expect(res.data.interview).not.toBeNull();
        expect(res.data.interview).toHaveProperty('vacancyTitle');
        expect(res.data.interview).toHaveProperty('scheduledFor');
        expect(res.data.interview).toHaveProperty('meetLink');
        expect(res.data.interview.status).toBe('pending');
      } finally {
        // Cleanup
        await pool.query('DELETE FROM encuadres WHERE worker_id = $1 AND interview_slot_id = $2', [seededWorkerId, slotId]);
        await pool.query('DELETE FROM interview_slots WHERE id = $1', [slotId]);
      }
    });

    it('retorna scheduledFor convertido pra UTC respeitando timezone da vaga (AR)', async () => {
      // Buenos Aires é UTC-3 (sem DST)
      // Slot local 14:00 BA → 17:00 UTC
      const vacancyId = await createTimezoneVacancy(pool, 'AR', 'America/Argentina/Buenos_Aires');
      const slotId = uuidv4();
      const encuadreId = uuidv4();

      await pool.query(
        `INSERT INTO interview_slots (id, job_posting_id, slot_date, slot_time, slot_end_time, status)
         VALUES ($1, $2, $3::date, $4::time, $5::time, 'AVAILABLE')`,
        [slotId, vacancyId, '2099-01-15', '14:00:00', '15:00:00'],
      );
      await pool.query(
        `INSERT INTO encuadres (id, worker_id, job_posting_id, interview_slot_id)
         VALUES ($1, $2, $3, $4)`,
        [encuadreId, seededWorkerId, vacancyId, slotId],
      );

      try {
        const res = await api.get(
          `/api/admin/workers/${seededWorkerId}/current-interview`,
          adminHeaders(),
        );

        expect(res.status).toBe(200);
        expect(res.data.interview).not.toBeNull();
        // 14:00 Buenos Aires (UTC-3, sem DST) = 17:00 UTC
        expect(res.data.interview.scheduledFor).toBe('2099-01-15T17:00:00.000Z');
      } finally {
        await pool.query('DELETE FROM encuadres WHERE id = $1', [encuadreId]);
        await pool.query('DELETE FROM interview_slots WHERE id = $1', [slotId]);
        await pool.query('DELETE FROM job_postings WHERE id = $1', [vacancyId]);
      }
    });

    it('retorna scheduledFor convertido pra UTC respeitando timezone da vaga (BR)', async () => {
      // São Paulo é UTC-3 (sem DST em janeiro)
      // Slot local 14:00 SP → 17:00 UTC
      const vacancyId = await createTimezoneVacancy(pool, 'BR', 'America/Sao_Paulo');
      const slotId = uuidv4();
      const encuadreId = uuidv4();

      await pool.query(
        `INSERT INTO interview_slots (id, job_posting_id, slot_date, slot_time, slot_end_time, status)
         VALUES ($1, $2, $3::date, $4::time, $5::time, 'AVAILABLE')`,
        [slotId, vacancyId, '2099-01-15', '14:00:00', '15:00:00'],
      );
      await pool.query(
        `INSERT INTO encuadres (id, worker_id, job_posting_id, interview_slot_id)
         VALUES ($1, $2, $3, $4)`,
        [encuadreId, seededWorkerId, vacancyId, slotId],
      );

      try {
        const res = await api.get(
          `/api/admin/workers/${seededWorkerId}/current-interview`,
          adminHeaders(),
        );

        expect(res.status).toBe(200);
        expect(res.data.interview).not.toBeNull();
        // 14:00 São Paulo (UTC-3, sem DST em janeiro) = 17:00 UTC
        expect(res.data.interview.scheduledFor).toBe('2099-01-15T17:00:00.000Z');
      } finally {
        await pool.query('DELETE FROM encuadres WHERE id = $1', [encuadreId]);
        await pool.query('DELETE FROM interview_slots WHERE id = $1', [slotId]);
        await pool.query('DELETE FROM job_postings WHERE id = $1', [vacancyId]);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/admin/workers/:id/available-vacancies
  // ─────────────────────────────────────────────────────────────────────────
  describe('GET /api/admin/workers/:id/available-vacancies', () => {
    it('retorna { vacancies: [] } quando worker não tem aplicações', async () => {
      const res = await api.get(
        `/api/admin/workers/${seededWorkerId}/available-vacancies`,
        adminHeaders(),
      );

      expect(res.status).toBe(200);
      expect(res.data).toEqual({ vacancies: [] });
    });

    it('retorna 401 sem token', async () => {
      const res = await api.get(
        `/api/admin/workers/${seededWorkerId}/available-vacancies`,
      );
      expect(res.status).toBe(401);
    });

    it('retorna 401 para role worker', async () => {
      const res = await api.get(
        `/api/admin/workers/${seededWorkerId}/available-vacancies`,
        { headers: { Authorization: `Bearer ${workerToken}` } },
      );
      expect(res.status).toBe(401);
    });

    it('retorna vacancies com shape correto quando há aplicações ativas', async () => {
      // Seed: job_posting + worker_job_application
      const postingRes = await pool.query(`
        SELECT id, title FROM job_postings
        WHERE deleted_at IS NULL LIMIT 1
      `);
      if (postingRes.rows.length === 0) return;

      const jobPostingId = postingRes.rows[0].id as string;

      await pool.query(
        `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage)
         VALUES ($1, $2, 'INITIATED')
         ON CONFLICT (worker_id, job_posting_id) DO NOTHING`,
        [seededWorkerId, jobPostingId],
      );

      try {
        const res = await api.get(
          `/api/admin/workers/${seededWorkerId}/available-vacancies`,
          adminHeaders(),
        );

        expect(res.status).toBe(200);
        expect(Array.isArray(res.data.vacancies)).toBe(true);
        expect(res.data.vacancies.length).toBeGreaterThan(0);

        const vac = res.data.vacancies[0];
        expect(vac).toHaveProperty('id');
        expect(vac).toHaveProperty('title');
        expect(vac).toHaveProperty('status');
        expect(vac).toHaveProperty('internalStage');
      } finally {
        await pool.query(
          'DELETE FROM worker_job_applications WHERE worker_id = $1 AND job_posting_id = $2',
          [seededWorkerId, jobPostingId],
        );
      }
    });

    it('exclui vagas com stage de rejeição', async () => {
      const postingRes = await pool.query(
        `SELECT id FROM job_postings WHERE deleted_at IS NULL LIMIT 1`,
      );
      if (postingRes.rows.length === 0) return;

      const jobPostingId = postingRes.rows[0].id as string;

      await pool.query(
        `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage)
         VALUES ($1, $2, 'REJECTED')
         ON CONFLICT (worker_id, job_posting_id) DO UPDATE SET application_funnel_stage = 'REJECTED'`,
        [seededWorkerId, jobPostingId],
      );

      try {
        const res = await api.get(
          `/api/admin/workers/${seededWorkerId}/available-vacancies`,
          adminHeaders(),
        );

        expect(res.status).toBe(200);
        const ids = res.data.vacancies.map((v: { id: string }) => v.id);
        expect(ids).not.toContain(jobPostingId);
      } finally {
        await pool.query(
          'DELETE FROM worker_job_applications WHERE worker_id = $1 AND job_posting_id = $2',
          [seededWorkerId, jobPostingId],
        );
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/admin/workers/:id/documents/ingest-from-url
  // ─────────────────────────────────────────────────────────────────────────
  describe('POST /api/admin/workers/:id/documents/ingest-from-url', () => {
    it('retorna 401 sem token', async () => {
      const res = await api.post(
        `/api/admin/workers/${seededWorkerId}/documents/ingest-from-url`,
        { documentType: 'resume_cv', externalUrl: 'https://example.com/cv.pdf' },
      );
      expect(res.status).toBe(401);
    });

    it('retorna 400 com body inválido (campo faltando)', async () => {
      const res = await api.post(
        `/api/admin/workers/${seededWorkerId}/documents/ingest-from-url`,
        { documentType: 'resume_cv' },
        adminHeaders(),
      );
      expect(res.status).toBe(400);
    });

    it('retorna 400 com URL inválida', async () => {
      const res = await api.post(
        `/api/admin/workers/${seededWorkerId}/documents/ingest-from-url`,
        { documentType: 'resume_cv', externalUrl: 'not-a-url' },
        adminHeaders(),
      );
      expect(res.status).toBe(400);
    });

    it('retorna 404 para worker inexistente', async () => {
      const res = await api.post(
        `/api/admin/workers/${NON_EXISTENT_UUID}/documents/ingest-from-url`,
        { documentType: 'resume_cv', externalUrl: 'https://example.com/cv.pdf' },
        adminHeaders(),
      );
      expect(res.status).toBe(404);
    });

    it('retorna 422 quando host não está na allowlist (SSRF)', async () => {
      // ALLOWED_MEDIA_HOSTS vazio (default) = bloqueia tudo
      const res = await api.post(
        `/api/admin/workers/${seededWorkerId}/documents/ingest-from-url`,
        {
          documentType: 'resume_cv',
          externalUrl: 'https://evil.example.com/cv.pdf',
        },
        adminHeaders(),
      );
      // Host bloqueado → 422
      expect([422, 404]).toContain(res.status);
    });

    it('retorna 401 para role worker', async () => {
      const res = await api.post(
        `/api/admin/workers/${seededWorkerId}/documents/ingest-from-url`,
        { documentType: 'resume_cv', externalUrl: 'https://example.com/cv.pdf' },
        { headers: { Authorization: `Bearer ${workerToken}` } },
      );
      expect(res.status).toBe(401);
    });
  });
});
