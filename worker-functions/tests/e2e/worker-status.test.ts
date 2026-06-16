/**
 * worker-status.test.ts
 *
 * Teste E2E para validar o fluxo de status do worker, incluindo o guard
 * que impede REGISTERED sem campos obrigatórios completos (Migration 111).
 *
 * Fluxo testado:
 *   1. Criar worker → status = INCOMPLETE_REGISTER
 *   2. PUT /api/workers/:id/status → REGISTERED em worker incompleto → deve manter INCOMPLETE_REGISTER
 *   3. Criar job application → stage INITIATED (via inserção direta no banco)
 *   4. Atualizar stage → PLACED (via query direta no banco)
 *   5. PUT /api/workers/:id/status → DISABLED
 *   6. Guard: trigger bloqueia SET REGISTERED direto no banco em worker incompleto
 *
 * Obs: job applications não têm endpoint público de criação — são geradas
 * pelo pipeline de import. Por isso os cenários 3 e 4 usam inserção direta
 * no banco de teste, que é o padrão desta suíte E2E (ver match-results.test.ts).
 */

import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('Worker Status Refactor — Fluxo Principal (E2E)', () => {
  const api = createApiClient();
  let adminToken: string;
  let workerToken: string;
  let pool: Pool;

  // IDs de dados criados para cleanup
  let workerId: string;
  let jobPostingId: string;
  let applicationId: string;

  const TEST_SUFFIX = `${Date.now()}`;
  const TEST_AUTH_UID = `ws-e2e-${TEST_SUFFIX}`;
  const TEST_EMAIL = `ws-e2e-${TEST_SUFFIX}@example.com`;

  beforeAll(async () => {
    await waitForBackend(api);

    adminToken = await getMockToken(api, {
      uid: 'ws-admin-e2e',
      email: 'ws-admin@e2e.local',
      role: 'admin',
    });

    workerToken = await getMockToken(api, {
      uid: TEST_AUTH_UID,
      email: TEST_EMAIL,
      role: 'worker',
    });

    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    // Cleanup em ordem de FK: applications → workers e job_postings
    if (applicationId) {
      await pool
        .query('DELETE FROM worker_job_applications WHERE id = $1', [applicationId])
        .catch(() => {});
    }
    if (workerId) {
      await pool.query('DELETE FROM workers WHERE id = $1', [workerId]).catch(() => {});
    }
    if (jobPostingId) {
      await pool.query('DELETE FROM job_postings WHERE id = $1', [jobPostingId]).catch(() => {});
    }
    if (pool) await pool.end();
  });

  function adminHeaders() {
    return { headers: { Authorization: `Bearer ${adminToken}` } };
  }

  function workerHeaders() {
    return { headers: { Authorization: `Bearer ${workerToken}` } };
  }

  // ── Cenário 1: Criar worker → status INCOMPLETE_REGISTER ─────────────────────

  describe('Cenário 1 — Criar worker → status deve ser INCOMPLETE_REGISTER', () => {
    it('POST /api/workers/init retorna 201 e cria worker com status INCOMPLETE_REGISTER', async () => {
      // Act
      const res = await api.post(
        '/api/workers/init',
        {
          authUid: TEST_AUTH_UID,
          email: TEST_EMAIL,
          phone: '+5511987654321',
          country: 'BR',
        },
        workerHeaders(),
      );

      // Assert — HTTP
      expect(res.status).toBe(201);
      expect(res.data.success).toBe(true);
      expect(res.data.data.status).toBe('ok');
      expect(res.data.data.worker).toHaveProperty('id');

      workerId = res.data.data.worker.id as string;

      // Assert — banco
      const dbResult = await pool.query('SELECT status FROM workers WHERE id = $1', [workerId]);
      expect(dbResult.rows.length).toBe(1);
      expect(dbResult.rows[0].status).toBe('INCOMPLETE_REGISTER');
    });
  });

  // ── Cenário 2: PUT /api/workers/:id/status → REGISTERED em worker incompleto ─

  describe('Cenário 2 — REGISTERED em worker incompleto deve manter INCOMPLETE_REGISTER', () => {
    it('deve retornar 200 mas manter status = INCOMPLETE_REGISTER (worker sem campos obrigatórios)', async () => {
      // Act — tentar forçar REGISTERED em worker que só tem email/phone/country
      const res = await api.put(
        `/api/workers/${workerId}/status`,
        { status: 'REGISTERED' },
        adminHeaders(),
      );

      // Assert — HTTP: retorna 200 com o status REAL (não o solicitado)
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.data.status).toBe('INCOMPLETE_REGISTER');

      // Assert — banco: status continua INCOMPLETE_REGISTER
      const dbResult = await pool.query('SELECT status FROM workers WHERE id = $1', [workerId]);
      expect(dbResult.rows[0].status).toBe('INCOMPLETE_REGISTER');
    });

    it('não deve ter gerado transição em worker_status_history (status não mudou)', async () => {
      const histResult = await pool.query(
        `SELECT old_value, new_value
         FROM worker_status_history
         WHERE worker_id = $1`,
        [workerId],
      );
      expect(histResult.rows.length).toBe(0);
    });

    it('deve retornar 400 para status inválido (valor antigo "approved")', async () => {
      const res = await api.put(
        `/api/workers/${workerId}/status`,
        { status: 'approved' },
        adminHeaders(),
      );
      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
    });
  });

  // ── Cenário 3: Criar job application com stage INITIATED ─────────────────────

  describe('Cenário 3 — Criar job application com stage INITIATED', () => {
    it('deve persistir application com application_funnel_stage = INITIATED', async () => {
      // Arrange — criar job posting de suporte
      const jpResult = await pool.query(
        `INSERT INTO job_postings (title, description, country, status)
         VALUES ('Vaga E2E Worker Status', 'Teste E2E', 'BR', 'ACTIVE')
         RETURNING id`,
      );
      jobPostingId = jpResult.rows[0].id as string;

      // Act — inserir application com stage explícito
      const appResult = await pool.query(
        `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage)
         VALUES ($1, $2, 'INITIATED')
         RETURNING id, application_funnel_stage`,
        [workerId, jobPostingId],
      );

      applicationId = appResult.rows[0].id as string;

      // Assert
      expect(appResult.rows[0].application_funnel_stage).toBe('INITIATED');
    });
  });

  // ── Cenário 4: Atualizar stage para SELECTED ─────────────────────────────────
  // PLACED foi removido do CHECK pós-migration 191/194; usar SELECTED (válido atualmente).

  describe('Cenário 4 — Atualizar application_funnel_stage → SELECTED', () => {
    it('deve persistir stage = SELECTED no banco após UPDATE', async () => {
      // Act
      await pool.query(
        `UPDATE worker_job_applications
         SET application_funnel_stage = 'SELECTED'
         WHERE id = $1`,
        [applicationId],
      );

      // Assert
      const result = await pool.query(
        'SELECT application_funnel_stage FROM worker_job_applications WHERE id = $1',
        [applicationId],
      );
      expect(result.rows[0].application_funnel_stage).toBe('SELECTED');
    });

    it('deve rejeitar UPDATE para stage antigo "HIRED"', async () => {
      await expect(
        pool.query(
          `UPDATE worker_job_applications
           SET application_funnel_stage = 'HIRED'
           WHERE id = $1`,
          [applicationId],
        ),
      ).rejects.toThrow();
    });
  });

  // ── Cenário 5: PUT /api/workers/:id/status → DISABLED ────────────────────────

  describe('Cenário 5 — PUT /api/workers/:id/status → DISABLED', () => {
    it('deve retornar 200 e persistir status = DISABLED no banco', async () => {
      // Act
      const res = await api.put(
        `/api/workers/${workerId}/status`,
        { status: 'DISABLED' },
        adminHeaders(),
      );

      // Assert — HTTP
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.data.status).toBe('DISABLED');

      // Assert — banco
      const dbResult = await pool.query('SELECT status FROM workers WHERE id = $1', [workerId]);
      expect(dbResult.rows[0].status).toBe('DISABLED');
    });

    it('deve ter 1 linha em worker_status_history (INCOMPLETE_REGISTER → DISABLED)', async () => {
      const histResult = await pool.query(
        `SELECT old_value, new_value
         FROM worker_status_history
         WHERE worker_id = $1
         ORDER BY created_at ASC`,
        [workerId],
      );
      // Única transição: INCOMPLETE_REGISTER → DISABLED (Cenário 5)
      // Cenário 2 NÃO gera transição porque recalculateStatus manteve INCOMPLETE_REGISTER
      expect(histResult.rows.length).toBe(1);
      expect(histResult.rows[0].old_value).toBe('INCOMPLETE_REGISTER');
      expect(histResult.rows[0].new_value).toBe('DISABLED');
    });
  });

  // ── Cenário 6: Guard trigger bloqueia SET REGISTERED direto no banco ─────

  describe('Cenário 6 — Trigger bloqueia SET REGISTERED direto em worker incompleto', () => {
    it('deve lançar exceção ao tentar UPDATE direto no banco', async () => {
      // Voltar para INCOMPLETE_REGISTER para testar o guard
      await pool.query(
        `UPDATE workers SET status = 'INCOMPLETE_REGISTER' WHERE id = $1`,
        [workerId],
      );

      // Tentar SET REGISTERED direto — a trigger deve bloquear
      await expect(
        pool.query(
          `UPDATE workers SET status = 'REGISTERED' WHERE id = $1`,
          [workerId],
        ),
      ).rejects.toThrow();
    });
  });
});
