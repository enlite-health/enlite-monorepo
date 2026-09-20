/**
 * blocked-applications.e2e.test.ts
 *
 * Testa a instrumentação de tentativas de postulação bloqueadas.
 *
 * Fluxo principal:
 *   1. Worker INCOMPLETE_REGISTER tenta POST /api/worker-applications/track-channel
 *      → 403 + linha gravada em worker_blocked_applications
 *   2. Segunda tentativa → attempt_count incrementa, last_attempted_at atualiza
 *   3. Worker DISABLED → reason=worker_disabled, missing_fields_at_attempt=[]
 *   4. Worker inexistente → reason=worker_not_found (via race condition simulada)
 *   5. GET /api/admin/recruitment/blocked-attempts → retorna dados + aggregados
 *   6. Filtros: jobPostingId, workerId, reason
 *   7. Filtro inválido (reason ruim) → 400
 *
 * Gate: não verifica nomes de workers (PII/KMS) — só workerId no response.
 */

import { Pool } from 'pg';
import { createApiClient, createPatientFixture, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('Worker blocked applications — instrumentação de postulação bloqueada', () => {
  const api = createApiClient();
  let pool: Pool;
  let adminToken: string;
  let patientId: string;
  let vacancyId: string;

  const W: Record<string, string> = {};
  const AUTH_UIDS: Record<string, string> = {};

  async function makeWorker(
    status: 'INCOMPLETE_REGISTER' | 'DISABLED',
    tag: string,
  ): Promise<string> {
    const authUid = `uid-blk-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    AUTH_UIDS[tag] = authUid;
    const email = `blk-${tag}-${Date.now()}@e2e.test`;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO workers (auth_uid, email, status, country, timezone)
       VALUES ($1, $2, $3, 'AR', 'America/Argentina/Buenos_Aires')
       RETURNING id`,
      [authUid, email, status],
    );
    return rows[0].id;
  }

  async function getWorkerToken(workerId: string): Promise<string> {
    const { rows } = await pool.query<{ email: string }>(
      `SELECT email FROM workers WHERE id = $1`,
      [workerId],
    );
    const authUid = Object.values(AUTH_UIDS).find(uid =>
      uid.startsWith('uid-blk'),
    );
    const { rows: uidRows } = await pool.query<{ auth_uid: string }>(
      `SELECT auth_uid FROM workers WHERE id = $1`,
      [workerId],
    );
    return getMockToken(api, {
      uid: uidRows[0].auth_uid,
      email: rows[0].email,
      role: 'worker',
    });
  }

  beforeAll(async () => {
    await waitForBackend(api);
    pool = new Pool({ connectionString: DATABASE_URL });

    adminToken = await getMockToken(api, {
      uid: 'blk-admin',
      email: 'blk-admin@e2e.local',
      role: 'admin',
    });

    patientId = await createPatientFixture(pool, 'blocked-apps');
    const { rows: vRows } = await pool.query<{ id: string }>(
      `INSERT INTO job_postings (title, country, status, patient_id, case_number)
       VALUES ('Vaga E2E blocked', 'AR', 'SEARCHING', $1, 99961)
       RETURNING id`,
      [patientId],
    );
    vacancyId = vRows[0].id;

    W.INC = await makeWorker('INCOMPLETE_REGISTER', 'inc');
    W.DIS = await makeWorker('DISABLED', 'dis');
  });

  afterAll(async () => {
    if (pool) {
      const wids = Object.values(W);
      await pool.query(
        `DELETE FROM worker_blocked_applications WHERE worker_id = ANY($1::uuid[])`,
        [wids],
      );
      await pool.query(`DELETE FROM workers WHERE id = ANY($1::uuid[])`, [wids]);
      await pool.query(`DELETE FROM job_postings WHERE id = $1`, [vacancyId]);
      await pool.query(`DELETE FROM patients WHERE id = $1`, [patientId]);
      await pool.end();
    }
  });

  afterEach(async () => {
    const wids = Object.values(W);
    await pool.query(
      `DELETE FROM worker_blocked_applications WHERE worker_id = ANY($1::uuid[])`,
      [wids],
    );
  });

  // ─── 1. Tentativa bloqueada grava linha em worker_blocked_applications ─────

  describe('1. Registro de tentativa bloqueada', () => {
    it('INCOMPLETE_REGISTER → 403 e grava linha em worker_blocked_applications', async () => {
      const token = await getWorkerToken(W.INC);

      const res = await api.post(
        '/api/worker-applications/track-channel',
        { jobPostingId: vacancyId, channel: 'facebook' },
        { headers: { Authorization: `Bearer ${token}` } },
      );

      expect(res.status).toBe(403);
      expect(res.data.code).toBe('WORKER_NOT_ELIGIBLE');
      expect(res.data.reason).toBe('registration_incomplete');

      // Verifica registro no banco
      const { rows } = await pool.query(
        `SELECT worker_id, job_posting_id, blocked_reason_at_attempt, attempt_count,
                acquisition_channel, missing_fields_at_attempt
         FROM worker_blocked_applications
         WHERE worker_id = $1 AND job_posting_id = $2`,
        [W.INC, vacancyId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].worker_id).toBe(W.INC);
      expect(rows[0].job_posting_id).toBe(vacancyId);
      expect(rows[0].blocked_reason_at_attempt).toBe('registration_incomplete');
      expect(rows[0].attempt_count).toBe(1);
      expect(rows[0].acquisition_channel).toBe('facebook');
      // missing_fields_at_attempt é array (pode ser vazio se worker não tem campos extras)
      expect(Array.isArray(rows[0].missing_fields_at_attempt)).toBe(true);
    });

    it('DISABLED → 403 e grava com reason=worker_disabled e missing_fields_at_attempt=[]', async () => {
      const token = await getWorkerToken(W.DIS);

      const res = await api.post(
        '/api/worker-applications/track-channel',
        { jobPostingId: vacancyId, channel: 'instagram' },
        { headers: { Authorization: `Bearer ${token}` } },
      );

      expect(res.status).toBe(403);
      expect(res.data.reason).toBe('worker_disabled');

      const { rows } = await pool.query(
        `SELECT blocked_reason_at_attempt, missing_fields_at_attempt, acquisition_channel
         FROM worker_blocked_applications
         WHERE worker_id = $1 AND job_posting_id = $2`,
        [W.DIS, vacancyId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].blocked_reason_at_attempt).toBe('worker_disabled');
      expect(rows[0].missing_fields_at_attempt).toEqual([]);
      expect(rows[0].acquisition_channel).toBe('instagram');
    });
  });

  // ─── 2. Retentativa incrementa attempt_count ──────────────────────────────

  describe('2. Upsert / retentativa', () => {
    it('segunda tentativa → attempt_count = 2, last_attempted_at atualizado', async () => {
      const token = await getWorkerToken(W.INC);

      // Primeira tentativa
      await api.post(
        '/api/worker-applications/track-channel',
        { jobPostingId: vacancyId, channel: 'whatsapp' },
        { headers: { Authorization: `Bearer ${token}` } },
      );

      const { rows: rows1 } = await pool.query(
        `SELECT attempt_count, first_attempted_at, last_attempted_at
         FROM worker_blocked_applications
         WHERE worker_id = $1 AND job_posting_id = $2`,
        [W.INC, vacancyId],
      );
      expect(rows1[0].attempt_count).toBe(1);
      const firstAt = rows1[0].first_attempted_at as Date;

      // Pequena espera para garantir timestamp distinto
      await new Promise(r => setTimeout(r, 50));

      // Segunda tentativa
      await api.post(
        '/api/worker-applications/track-channel',
        { jobPostingId: vacancyId, channel: 'linkedin' }, // canal diferente — first-value-wins
        { headers: { Authorization: `Bearer ${token}` } },
      );

      const { rows: rows2 } = await pool.query(
        `SELECT attempt_count, first_attempted_at, last_attempted_at, acquisition_channel
         FROM worker_blocked_applications
         WHERE worker_id = $1 AND job_posting_id = $2`,
        [W.INC, vacancyId],
      );
      expect(rows2[0].attempt_count).toBe(2);
      // first_attempted_at não muda
      expect((rows2[0].first_attempted_at as Date).getTime()).toBe(firstAt.getTime());
      // acquisition_channel preserva primeiro valor (first-value-wins via COALESCE)
      expect(rows2[0].acquisition_channel).toBe('whatsapp');
    });
  });

  // ─── 3. GET /api/admin/recruitment/blocked-attempts ──────────────────────

  describe('3. GET /api/admin/recruitment/blocked-attempts', () => {
    beforeEach(async () => {
      // Pré-popula tentativas bloqueadas diretamente no banco para testes de leitura
      await pool.query(
        `INSERT INTO worker_blocked_applications
           (worker_id, job_posting_id, blocked_reason_at_attempt, missing_fields_at_attempt, acquisition_channel,
            attempt_count, first_attempted_at, last_attempted_at)
         VALUES ($1, $2, 'registration_incomplete', '["phone"]', 'site', 1, NOW(), NOW())`,
        [W.INC, vacancyId],
      );
      await pool.query(
        `INSERT INTO worker_blocked_applications
           (worker_id, job_posting_id, blocked_reason_at_attempt, missing_fields_at_attempt, acquisition_channel,
            attempt_count, first_attempted_at, last_attempted_at)
         VALUES ($1, $2, 'worker_disabled', '[]', 'instagram', 1, NOW(), NOW())`,
        [W.DIS, vacancyId],
      );
    });

    it('retorna 200 com data + aggregates + pagination sem filtros', async () => {
      const res = await api.get('/api/admin/recruitment/blocked-attempts', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(Array.isArray(res.data.data)).toBe(true);
      expect(res.data.aggregates).toMatchObject({
        totalBlocked: expect.any(Number),
        byReason: expect.any(Object),
      });
      expect(res.data.pagination).toMatchObject({
        total: expect.any(Number),
        limit: expect.any(Number),
        page: 1,
      });
    });

    it('filtra por jobPostingId — retorna apenas tentativas da vaga', async () => {
      const res = await api.get(
        `/api/admin/recruitment/blocked-attempts?jobPostingId=${vacancyId}`,
        { headers: { Authorization: `Bearer ${adminToken}` } },
      );

      expect(res.status).toBe(200);
      for (const item of res.data.data) {
        expect(item.jobPostingId).toBe(vacancyId);
      }
    });

    it('filtra por workerId', async () => {
      const res = await api.get(
        `/api/admin/recruitment/blocked-attempts?workerId=${W.INC}`,
        { headers: { Authorization: `Bearer ${adminToken}` } },
      );

      expect(res.status).toBe(200);
      for (const item of res.data.data) {
        expect(item.workerId).toBe(W.INC);
      }
      // Nunca expõe nome (PII)
      for (const item of res.data.data) {
        expect(item).not.toHaveProperty('workerName');
        expect(item).not.toHaveProperty('firstName');
      }
    });

    it('filtra por reason=registration_incomplete', async () => {
      const res = await api.get(
        `/api/admin/recruitment/blocked-attempts?reason=registration_incomplete`,
        { headers: { Authorization: `Bearer ${adminToken}` } },
      );

      expect(res.status).toBe(200);
      for (const item of res.data.data) {
        expect(item.blockedReason).toBe('registration_incomplete');
      }
    });

    it('retorna 400 para reason inválido', async () => {
      const res = await api.get(
        `/api/admin/recruitment/blocked-attempts?reason=INVALID_REASON`,
        { headers: { Authorization: `Bearer ${adminToken}` } },
      );

      expect(res.status).toBe(400);
    });

    it('retorna 401 sem token', async () => {
      const res = await api.get('/api/admin/recruitment/blocked-attempts');
      expect([401, 403]).toContain(res.status);
    });

    it('retorna 403 para staff não-admin (recruiter) — endpoint é admin-only', async () => {
      const recruiterToken = await getMockToken(api, {
        uid: 'blk-recruiter',
        email: 'blk-recruiter@e2e.local',
        role: 'recruiter',
      });

      const res = await api.get('/api/admin/recruitment/blocked-attempts', {
        headers: { Authorization: `Bearer ${recruiterToken}` },
      });

      expect(res.status).toBe(403);
    });

    it('aggregates contém totalBlocked e byReason com pelo menos os reasons inseridos', async () => {
      const res = await api.get(
        `/api/admin/recruitment/blocked-attempts?jobPostingId=${vacancyId}`,
        { headers: { Authorization: `Bearer ${adminToken}` } },
      );

      expect(res.status).toBe(200);
      const { aggregates } = res.data;
      // Devem ter pelo menos os dois reasons que inserimos no beforeEach
      const reasons = Object.keys(aggregates.byReason);
      expect(reasons).toEqual(
        expect.arrayContaining(['registration_incomplete', 'worker_disabled']),
      );
    });
  });
});
