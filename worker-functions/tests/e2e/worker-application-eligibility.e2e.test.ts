/**
 * worker-application-eligibility.e2e.test.ts
 *
 * Garante que worker com cadastro/documentos incompletos NÃO consegue se
 * postular ou ter sua application movida no funil. Cobre:
 *
 *   1. POST /api/worker-applications/track-channel — worker token
 *        - status='REGISTERED'         → 200 (cria WJA)
 *        - status='INCOMPLETE_REGISTER'→ 403 + code='WORKER_NOT_ELIGIBLE'
 *        - status='DISABLED'           → 403
 *
 *   2. PUT /api/admin/encuadres/:id/move — admin token
 *        - worker status='REGISTERED'         → 200 (atualiza WJA)
 *        - worker status='INCOMPLETE_REGISTER'→ 403
 *
 *   3. DB trigger (defesa em profundidade)
 *        - INSERT worker_job_applications com worker INCOMPLETE + source='manual'
 *          → falha com check_violation
 *        - INSERT com source='planilla_operativa' → permitido (bypass histórico)
 */

import { Pool } from 'pg';
import { createApiClient, createPatientFixture, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('Worker application eligibility — bloqueio de postulação incompleta', () => {
  const api = createApiClient();
  let pool: Pool;
  let adminToken: string;
  let patientId: string;
  let vacancyId: string;

  const W: Record<string, string> = {};
  const E: Record<string, string> = {};

  async function makeWorker(status: 'REGISTERED' | 'INCOMPLETE_REGISTER' | 'DISABLED', tag: string): Promise<string> {
    const authUid = `uid-elig-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const email = `elig-${tag}-${Date.now()}@e2e.test`;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO workers (auth_uid, email, status, country, timezone)
       VALUES ($1, $2, $3, 'AR', 'America/Argentina/Buenos_Aires')
       RETURNING id`,
      [authUid, email, status],
    );
    return rows[0].id;
  }

  beforeAll(async () => {
    await waitForBackend(api);
    pool = new Pool({ connectionString: DATABASE_URL });

    adminToken = await getMockToken(api, {
      uid: 'elig-admin',
      email: 'elig-admin@e2e.local',
      role: 'admin',
    });

    patientId = await createPatientFixture(pool, 'eligibility');
    const vacancy = await pool.query<{ id: string }>(
      `INSERT INTO job_postings (title, country, status, patient_id, case_number)
       VALUES ('Caso E2E eligibility', 'AR', 'SEARCHING', $1, 99971)
       RETURNING id`,
      [patientId],
    );
    vacancyId = vacancy.rows[0].id;

    W.REG = await makeWorker('REGISTERED', 'reg');
    W.INC = await makeWorker('INCOMPLETE_REGISTER', 'inc');
    W.DIS = await makeWorker('DISABLED', 'dis');

    // Encuadres pre-criados pra teste do admin move
    for (const [tag, workerId] of Object.entries(W)) {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO encuadres (worker_id, job_posting_id, worker_raw_name)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [workerId, vacancyId, `Worker ${tag}`],
      );
      E[tag] = rows[0].id;
    }
  });

  afterAll(async () => {
    if (pool) {
      const wids = Object.values(W);
      await pool.query(`DELETE FROM worker_job_applications WHERE worker_id = ANY($1::uuid[])`, [wids]);
      await pool.query(`DELETE FROM encuadres WHERE worker_id = ANY($1::uuid[])`, [wids]);
      await pool.query(`DELETE FROM workers WHERE id = ANY($1::uuid[])`, [wids]);
      await pool.query(`DELETE FROM job_postings WHERE id = $1`, [vacancyId]);
      await pool.query(`DELETE FROM patients WHERE id = $1`, [patientId]);
      await pool.end();
    }
  });

  afterEach(async () => {
    const wids = Object.values(W);
    await pool.query(`DELETE FROM worker_job_applications WHERE worker_id = ANY($1::uuid[])`, [wids]);
  });

  // ─────────────────────────────────────────────────────────────────
  // 1. POST /api/worker-applications/track-channel
  // ─────────────────────────────────────────────────────────────────

  describe('POST /api/worker-applications/track-channel', () => {
    async function getWorkerToken(authUid: string, workerId: string): Promise<string> {
      const { rows } = await pool.query<{ email: string }>(
        `SELECT email FROM workers WHERE id = $1`,
        [workerId],
      );
      return getMockToken(api, { uid: authUid, email: rows[0].email, role: 'worker' });
    }

    async function getAuthUid(workerId: string): Promise<string> {
      const { rows } = await pool.query<{ auth_uid: string }>(
        `SELECT auth_uid FROM workers WHERE id = $1`,
        [workerId],
      );
      return rows[0].auth_uid;
    }

    it('REGISTERED → 200 e cria worker_job_applications', async () => {
      const uid = await getAuthUid(W.REG);
      const token = await getWorkerToken(uid, W.REG);

      const res = await api.post(
        '/api/worker-applications/track-channel',
        { jobPostingId: vacancyId, channel: 'facebook' },
        { headers: { Authorization: `Bearer ${token}` } },
      );

      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);

      const { rows } = await pool.query(
        `SELECT acquisition_channel, source FROM worker_job_applications
          WHERE worker_id = $1 AND job_posting_id = $2`,
        [W.REG, vacancyId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].acquisition_channel).toBe('facebook');
      expect(rows[0].source).toBe('manual');
    });

    it('INCOMPLETE_REGISTER → 403 com code=WORKER_NOT_ELIGIBLE', async () => {
      const uid = await getAuthUid(W.INC);
      const token = await getWorkerToken(uid, W.INC);

      const res = await api.post(
        '/api/worker-applications/track-channel',
        { jobPostingId: vacancyId, channel: 'instagram' },
        { headers: { Authorization: `Bearer ${token}` } },
      );

      expect(res.status).toBe(403);
      expect(res.data.success).toBe(false);
      expect(res.data.code).toBe('WORKER_NOT_ELIGIBLE');
      expect(res.data.reason).toBe('registration_incomplete');
      expect(res.data.workerStatus).toBe('INCOMPLETE_REGISTER');

      // Nenhuma WJA criada
      const { rows } = await pool.query(
        `SELECT id FROM worker_job_applications WHERE worker_id = $1`,
        [W.INC],
      );
      expect(rows).toHaveLength(0);
    });

    it('DISABLED → 403 com reason=worker_disabled', async () => {
      const uid = await getAuthUid(W.DIS);
      const token = await getWorkerToken(uid, W.DIS);

      const res = await api.post(
        '/api/worker-applications/track-channel',
        { jobPostingId: vacancyId, channel: 'whatsapp' },
        { headers: { Authorization: `Bearer ${token}` } },
      );

      expect(res.status).toBe(403);
      expect(res.data.code).toBe('WORKER_NOT_ELIGIBLE');
      expect(res.data.reason).toBe('worker_disabled');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 2. PUT /api/admin/encuadres/:id/move
  // ─────────────────────────────────────────────────────────────────

  describe('PUT /api/admin/encuadres/:id/move', () => {
    it('worker REGISTERED → 200 e atualiza application_funnel_stage', async () => {
      const res = await api.put(
        `/api/admin/encuadres/${E.REG}/move`,
        { targetStage: 'CONFIRMED' },
        { headers: { Authorization: `Bearer ${adminToken}` } },
      );

      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);

      const { rows } = await pool.query(
        `SELECT application_funnel_stage FROM worker_job_applications
          WHERE worker_id = $1 AND job_posting_id = $2`,
        [W.REG, vacancyId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].application_funnel_stage).toBe('CONFIRMED');
    });

    it('worker INCOMPLETE_REGISTER → 403 com code=WORKER_NOT_ELIGIBLE', async () => {
      const res = await api.put(
        `/api/admin/encuadres/${E.INC}/move`,
        { targetStage: 'CONFIRMED' },
        { headers: { Authorization: `Bearer ${adminToken}` } },
      );

      expect(res.status).toBe(403);
      expect(res.data.code).toBe('WORKER_NOT_ELIGIBLE');
      expect(res.data.reason).toBe('registration_incomplete');

      // Nenhuma WJA criada via tentativa de move
      const { rows } = await pool.query(
        `SELECT id FROM worker_job_applications WHERE worker_id = $1`,
        [W.INC],
      );
      expect(rows).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 3. DB trigger — defesa em profundidade
  // ─────────────────────────────────────────────────────────────────

  describe('DB trigger trg_enforce_worker_registered', () => {
    it('INSERT direto com worker INCOMPLETE_REGISTER + source=manual → falha', async () => {
      await expect(
        pool.query(
          `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_status, source)
           VALUES ($1, $2, 'applied', 'manual')`,
          [W.INC, vacancyId],
        ),
      ).rejects.toThrow(/cannot apply|REGISTERED|status=INCOMPLETE_REGISTER/);
    });

    it('INSERT com worker INCOMPLETE_REGISTER + source=planilla_operativa → permitido (bypass histórico)', async () => {
      await expect(
        pool.query(
          `INSERT INTO worker_job_applications
             (worker_id, job_posting_id, application_status, source, application_funnel_stage)
           VALUES ($1, $2, 'applied', 'planilla_operativa', 'INVITED')`,
          [W.INC, vacancyId],
        ),
      ).resolves.toBeDefined();

      const { rows } = await pool.query(
        `SELECT source FROM worker_job_applications WHERE worker_id = $1 AND job_posting_id = $2`,
        [W.INC, vacancyId],
      );
      expect(rows[0].source).toBe('planilla_operativa');
    });

    it('INSERT com worker REGISTERED → permitido', async () => {
      await expect(
        pool.query(
          `INSERT INTO worker_job_applications
             (worker_id, job_posting_id, application_status, source, application_funnel_stage)
           VALUES ($1, $2, 'applied', 'manual', 'INVITED')`,
          [W.REG, vacancyId],
        ),
      ).resolves.toBeDefined();
    });

    it('UPDATE em WJA com source=manual de worker que virou INCOMPLETE → falha', async () => {
      // Cria worker REGISTERED + WJA com source=manual
      const workerId = await makeWorker('REGISTERED', 'upd-test');
      try {
        await pool.query(
          `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_status, source, application_funnel_stage)
           VALUES ($1, $2, 'applied', 'manual', 'INITIATED')`,
          [workerId, vacancyId],
        );

        // Worker perde elegibilidade
        await pool.query(`UPDATE workers SET status = 'INCOMPLETE_REGISTER' WHERE id = $1`, [workerId]);

        // UPDATE de funnel_stage deve falhar — trigger reavalia status do worker
        await expect(
          pool.query(
            `UPDATE worker_job_applications SET application_funnel_stage = 'CONFIRMED'
              WHERE worker_id = $1 AND job_posting_id = $2`,
            [workerId, vacancyId],
          ),
        ).rejects.toThrow(/cannot apply|REGISTERED|status=INCOMPLETE_REGISTER/);
      } finally {
        await pool.query(`DELETE FROM worker_job_applications WHERE worker_id = $1`, [workerId]);
        await pool.query(`DELETE FROM workers WHERE id = $1`, [workerId]);
      }
    });

    it('UPDATE em WJA com source=planilla_operativa de worker INCOMPLETE → permitido (bypass histórico)', async () => {
      // Cria WJA via bypass histórico
      await pool.query(
        `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_status, source, application_funnel_stage)
         VALUES ($1, $2, 'applied', 'planilla_operativa', 'INITIATED')`,
        [W.INC, vacancyId],
      );

      // UPDATE preserva source='planilla_operativa' → bypass continua aplicando
      await expect(
        pool.query(
          `UPDATE worker_job_applications SET application_funnel_stage = 'CONFIRMED'
            WHERE worker_id = $1 AND job_posting_id = $2`,
          [W.INC, vacancyId],
        ),
      ).resolves.toBeDefined();
    });
  });
});
