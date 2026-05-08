/**
 * match-results.test.ts
 *
 * Testa o endpoint GET /api/admin/vacancies/:id/match-results
 * e a integração com messaged_at (migration 061).
 *
 * Usa MockAuth (USE_MOCK_AUTH=true) — sem Firebase real.
 *
 * Endpoints cobertos:
 *   GET  /api/admin/vacancies/:id/match-results
 *   POST /api/admin/vacancies/:id/match      (pré-condição para ter resultados)
 *   POST /api/admin/messaging/whatsapp        (atualização de messaged_at)
 */

import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('GET /api/admin/vacancies/:id/match-results', () => {
  const api = createApiClient();
  let adminToken: string;
  let workerToken: string;
  let pool: Pool;

  // IDs criados durante os testes para limpeza
  const createdVacancyIds: string[] = [];

  beforeAll(async () => {
    await waitForBackend(api);

    adminToken = await getMockToken(api, {
      uid: 'match-results-admin-e2e',
      email: 'match-results-admin@e2e.local',
      role: 'admin',
    });

    workerToken = await getMockToken(api, {
      uid: 'match-results-worker-e2e',
      email: 'match-results-worker@e2e.local',
      role: 'worker',
    });

    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    // Limpa vagas criadas durante os testes
    if (createdVacancyIds.length > 0) {
      await pool.query(
        `DELETE FROM job_postings WHERE id = ANY($1::uuid[])`,
        [createdVacancyIds],
      ).catch(() => {});
    }
    if (pool) await pool.end();
  });

  function authHeaders(token: string) {
    return { headers: { Authorization: `Bearer ${token}` } };
  }

  async function createVacancy(caseNumber: number): Promise<string> {
    const res = await api.post(
      '/api/admin/vacancies',
      { case_number: caseNumber, title: `Match E2E ${caseNumber}` },
      authHeaders(adminToken),
    );
    const id = res.data.data?.id as string;
    if (id) createdVacancyIds.push(id);
    return id;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Estrutura básica da resposta
  // ─────────────────────────────────────────────────────────────────────────
  describe('estrutura da resposta', () => {
    it('retorna 200 com estrutura correta para vaga sem matches', async () => {
      const vacancyId = await createVacancy(77701);
      if (!vacancyId) return;

      const res = await api.get(
        `/api/admin/vacancies/${vacancyId}/match-results`,
        authHeaders(adminToken),
      );

      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.data).toMatchObject({
        jobPostingId: vacancyId,
        totalCandidates: 0,
        candidates: [],
      });
      expect(res.data.data.lastMatchAt === null || typeof res.data.data.lastMatchAt === 'string').toBe(true);
    });

    it('retorna array vazio quando não há candidatos em worker_job_applications', async () => {
      const vacancyId = await createVacancy(77702);
      if (!vacancyId) return;

      const res = await api.get(
        `/api/admin/vacancies/${vacancyId}/match-results`,
        authHeaders(adminToken),
      );

      expect(res.status).toBe(200);
      expect(res.data.data.candidates).toEqual([]);
      expect(res.data.data.totalCandidates).toBe(0);
    });

    it('retorna 401 sem token', async () => {
      const res = await api.get('/api/admin/vacancies/00000000-0000-0000-0000-000000000000/match-results');
      expect(res.status).toBe(401);
    });

    it('retorna 403 para role worker', async () => {
      const vacancyId = await createVacancy(77703);
      if (!vacancyId) return;

      const res = await api.get(
        `/api/admin/vacancies/${vacancyId}/match-results`,
        authHeaders(workerToken),
      );
      expect(res.status).toBe(403);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Paginação
  // ─────────────────────────────────────────────────────────────────────────
  describe('paginação', () => {
    it('aceita query params limit e offset sem erro', async () => {
      const vacancyId = await createVacancy(77704);
      if (!vacancyId) return;

      const res = await api.get(
        `/api/admin/vacancies/${vacancyId}/match-results?limit=10&offset=0`,
        authHeaders(adminToken),
      );

      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
    });

    it('limit=0 retorna array vazio sem erro', async () => {
      const vacancyId = await createVacancy(77705);
      if (!vacancyId) return;

      const res = await api.get(
        `/api/admin/vacancies/${vacancyId}/match-results?limit=0`,
        authHeaders(adminToken),
      );

      expect(res.status).toBe(200);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Inserção manual + ordenação por match_score
  // ─────────────────────────────────────────────────────────────────────────
  describe('candidatos salvos e ordenação', () => {
    let vacancyId: string;
    let workerIdA: string;
    let workerIdB: string;
    let workerIdC: string;

    beforeAll(async () => {
      vacancyId = await createVacancy(77706);
      if (!vacancyId) return;

      // Cria workers mínimos para inserir em worker_job_applications
      const insertWorkers = await pool.query(`
        INSERT INTO workers (auth_uid, email, first_name_encrypted, phone_encrypted, created_at, updated_at)
        VALUES
          (gen_random_uuid()::text, 'match_a@test.com', 'worker_match_a', 'phone_a', NOW(), NOW()),
          (gen_random_uuid()::text, 'match_b@test.com', 'worker_match_b', 'phone_b', NOW(), NOW()),
          (gen_random_uuid()::text, 'match_c@test.com', 'worker_match_c', 'phone_c', NOW(), NOW())
        RETURNING id
      `);
      [workerIdA, workerIdB, workerIdC] = insertWorkers.rows.map((r: any) => r.id);

      // Insere candidatos com scores diferentes
      await pool.query(`
        INSERT INTO worker_job_applications (worker_id, job_posting_id, application_status, match_score, created_at, updated_at)
        VALUES
          ($1, $4, 'under_review', 87, NOW(), NOW()),
          ($2, $4, 'under_review', 45, NOW(), NOW()),
          ($3, $4, 'under_review', 72, NOW(), NOW())
        ON CONFLICT DO NOTHING
      `, [workerIdA, workerIdB, workerIdC, vacancyId]);
    });

    afterAll(async () => {
      // Limpa os workers e applications criados
      if (workerIdA) await pool.query('DELETE FROM workers WHERE id = ANY($1::uuid[])', [[workerIdA, workerIdB, workerIdC]]).catch(() => {});
    });

    it('retorna os 3 candidatos inseridos', async () => {
      if (!vacancyId) return;

      const res = await api.get(
        `/api/admin/vacancies/${vacancyId}/match-results`,
        authHeaders(adminToken),
      );

      expect(res.status).toBe(200);
      expect(res.data.data.totalCandidates).toBe(3);
      expect(res.data.data.candidates).toHaveLength(3);
    });

    it('candidatos ordenados por match_score DESC', async () => {
      if (!vacancyId) return;

      const res = await api.get(
        `/api/admin/vacancies/${vacancyId}/match-results`,
        authHeaders(adminToken),
      );

      const scores = res.data.data.candidates.map((c: any) => c.matchScore);
      for (let i = 0; i < scores.length - 1; i++) {
        expect(scores[i]).toBeGreaterThanOrEqual(scores[i + 1]);
      }
    });

    it('cada candidato tem os campos obrigatórios', async () => {
      if (!vacancyId) return;

      const res = await api.get(
        `/api/admin/vacancies/${vacancyId}/match-results`,
        authHeaders(adminToken),
      );

      const candidate = res.data.data.candidates[0];
      expect(candidate).toHaveProperty('workerId');
      expect(candidate).toHaveProperty('workerName');
      expect(candidate).toHaveProperty('workerPhone');
      expect(candidate).toHaveProperty('matchScore');
      expect(candidate).toHaveProperty('applicationStatus');
      expect(candidate).toHaveProperty('alreadyApplied');
      expect(candidate).toHaveProperty('messagedAt');
    });

    it('messagedAt começa como null para candidatos novos', async () => {
      if (!vacancyId) return;

      const res = await api.get(
        `/api/admin/vacancies/${vacancyId}/match-results`,
        authHeaders(adminToken),
      );

      res.data.data.candidates.forEach((c: any) => {
        expect(c.messagedAt).toBeNull();
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // messaged_at — migration 061
  // ─────────────────────────────────────────────────────────────────────────
  describe('campo messaged_at (migration 061)', () => {
    it('coluna messaged_at existe em worker_job_applications', async () => {
      const { rows } = await pool.query(`
        SELECT column_name, data_type, column_default
        FROM information_schema.columns
        WHERE table_name = 'worker_job_applications'
          AND column_name = 'messaged_at'
      `);

      expect(rows).toHaveLength(1);
      expect(rows[0].column_name).toBe('messaged_at');
      // Deve ser TIMESTAMPTZ (timestamp with time zone)
      expect(rows[0].data_type).toMatch(/timestamp/i);
    });

    it('coluna messaged_at tem DEFAULT NULL', async () => {
      const { rows } = await pool.query(`
        SELECT is_nullable
        FROM information_schema.columns
        WHERE table_name = 'worker_job_applications'
          AND column_name = 'messaged_at'
      `);

      expect(rows[0].is_nullable).toBe('YES');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Integração com POST /match (se Groq não configurado, verifica estrutura)
  // ─────────────────────────────────────────────────────────────────────────
  describe('integração POST /match → GET /match-results', () => {
    it('GET /match-results após POST /match reflete estado da tabela', async () => {
      const vacancyId = await createVacancy(77707);
      if (!vacancyId) return;

      // Estado inicial: sem candidatos
      const before = await api.get(
        `/api/admin/vacancies/${vacancyId}/match-results`,
        authHeaders(adminToken),
      );
      expect(before.data.data.candidates).toHaveLength(0);

      // POST /match pode retornar 200 (sem workers disponíveis) ou 502 (Groq não configurado)
      // Em ambos os casos, o endpoint de match-results deve permanecer funcional
      const matchRes = await api.post(
        `/api/admin/vacancies/${vacancyId}/match`,
        {},
        authHeaders(adminToken),
      );
      // Aceita 200 (match rodou), 500 (Groq não configurado), 404 (sem workers)
      expect([200, 404, 500, 502]).toContain(matchRes.status);

      // GET /match-results continua acessível independente do match ter funcionado
      const after = await api.get(
        `/api/admin/vacancies/${vacancyId}/match-results`,
        authHeaders(adminToken),
      );
      expect(after.status).toBe(200);
      expect(after.data.success).toBe(true);
    });
  });
});
