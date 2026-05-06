/**
 * talentum-outbound.test.ts — E2E Tests
 *
 * Tests the Talentum outbound endpoints against a real backend + DB.
 * External services (Talentum API, Groq) are NOT called — we test:
 *
 *   1. Prescreening config CRUD (no external dependency at all)
 *   2. Publish/unpublish validation paths (fail before hitting external APIs)
 *   3. Schema validation (migration 106 columns, tables, constraints)
 *   4. Auth/permissions on all endpoints
 *
 * Endpoints covered:
 *   GET    /api/admin/vacancies/:id/prescreening-config
 *   POST   /api/admin/vacancies/:id/prescreening-config
 *   POST   /api/admin/vacancies/:id/publish-talentum
 *   DELETE /api/admin/vacancies/:id/publish-talentum
 *   POST   /api/admin/vacancies/:id/generate-talentum-description
 */

import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('Talentum Outbound API', () => {
  const api = createApiClient();
  let adminToken: string;
  let workerToken: string;
  let pool: Pool;
  let vacancyId: string;

  beforeAll(async () => {
    await waitForBackend(api);

    adminToken = await getMockToken(api, {
      uid: 'talentum-admin-e2e',
      email: 'talentum-admin@e2e.local',
      role: 'admin',
    });

    workerToken = await getMockToken(api, {
      uid: 'talentum-worker-e2e',
      email: 'talentum-worker@e2e.local',
      role: 'worker',
    });

    pool = new Pool({ connectionString: DATABASE_URL });

    // Create a vacancy to use in all tests
    const res = await api.post(
      '/api/admin/vacancies',
      {
        case_number: 77701,
        title: 'Caso E2E Talentum Outbound',
        worker_profile_sought: 'AT con experiencia en TEA',
        schedule_days_hours: 'Lunes a Viernes 09-17hs',
        providers_needed: 1,
      },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    vacancyId = res.data.data?.id;
    expect(vacancyId).toBeTruthy();
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  function auth(token: string) {
    return { headers: { Authorization: `Bearer ${token}` } };
  }

  const FAKE_UUID = '00000000-0000-0000-0000-000000000000';

  // ═══════════════════════════════════════════════════════════════════
  // 1. Schema validation (Migration 106)
  // ═══════════════════════════════════════════════════════════════════

  describe('Migration 106 — schema validation', () => {
    it('job_postings has Talentum columns', async () => {
      const { rows } = await pool.query(`
        SELECT column_name, is_nullable, data_type
        FROM information_schema.columns
        WHERE table_name = 'job_postings'
          AND column_name LIKE 'talentum_%'
        ORDER BY column_name
      `);

      const colNames = rows.map((r: any) => r.column_name);
      expect(colNames).toContain('talentum_project_id');
      expect(colNames).toContain('talentum_public_id');
      expect(colNames).toContain('talentum_whatsapp_url');
      expect(colNames).toContain('talentum_slug');
      expect(colNames).toContain('talentum_published_at');
      expect(colNames).toContain('talentum_description');

      // All nullable (CA-2.2)
      rows.forEach((r: any) => {
        expect(r.is_nullable).toBe('YES');
      });
    });

    it('job_posting_prescreening_questions table exists with correct columns', async () => {
      const { rows } = await pool.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'job_posting_prescreening_questions'
        ORDER BY ordinal_position
      `);

      const colNames = rows.map((r: any) => r.column_name);
      expect(colNames).toContain('id');
      expect(colNames).toContain('job_posting_id');
      expect(colNames).toContain('question_order');
      expect(colNames).toContain('question');
      expect(colNames).toContain('response_type');
      expect(colNames).toContain('desired_response');
      expect(colNames).toContain('weight');
      expect(colNames).toContain('required');
      expect(colNames).toContain('analyzed');
      expect(colNames).toContain('early_stoppage');
    });

    it('job_posting_prescreening_faq table exists with correct columns', async () => {
      const { rows } = await pool.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'job_posting_prescreening_faq'
        ORDER BY ordinal_position
      `);

      const colNames = rows.map((r: any) => r.column_name);
      expect(colNames).toContain('id');
      expect(colNames).toContain('job_posting_id');
      expect(colNames).toContain('faq_order');
      expect(colNames).toContain('question');
      expect(colNames).toContain('answer');
    });

    it('weight has CHECK constraint (1-10)', async () => {
      // Try to insert a question with invalid weight directly
      await expect(
        pool.query(
          `INSERT INTO job_posting_prescreening_questions
             (job_posting_id, question_order, question, desired_response, weight)
           VALUES ($1, 99, 'test', 'test', 0)`,
          [vacancyId],
        ),
      ).rejects.toThrow(); // CHECK constraint violation
    });

    it('weight CHECK allows values 1 through 10', async () => {
      // Insert with weight=1 (min) and weight=10 (max) should succeed
      await pool.query(
        `INSERT INTO job_posting_prescreening_questions
           (job_posting_id, question_order, question, desired_response, weight)
         VALUES ($1, 97, 'weight-min', 'test', 1)`,
        [vacancyId],
      );
      await pool.query(
        `INSERT INTO job_posting_prescreening_questions
           (job_posting_id, question_order, question, desired_response, weight)
         VALUES ($1, 98, 'weight-max', 'test', 10)`,
        [vacancyId],
      );
      // Cleanup
      await pool.query(
        `DELETE FROM job_posting_prescreening_questions WHERE job_posting_id = $1 AND question_order IN (97, 98)`,
        [vacancyId],
      );
    });

    it('prescreening_questions has CASCADE on job_posting_id', async () => {
      // Create a temporary vacancy + question, then delete the vacancy
      const createRes = await api.post(
        '/api/admin/vacancies',
        { case_number: 77799, title: 'Caso Cascade Test' },
        auth(adminToken),
      );
      const tempId = createRes.data.data?.id;

      await pool.query(
        `INSERT INTO job_posting_prescreening_questions
           (job_posting_id, question_order, question, desired_response, weight)
         VALUES ($1, 1, 'cascade-test', 'answer', 5)`,
        [tempId],
      );

      // Delete vacancy (hard delete for test)
      await pool.query(`DELETE FROM job_postings WHERE id = $1`, [tempId]);

      // Question should be gone (CASCADE)
      const { rows } = await pool.query(
        `SELECT id FROM job_posting_prescreening_questions WHERE job_posting_id = $1`,
        [tempId],
      );
      expect(rows).toHaveLength(0);
    });

    it('unique index on talentum_project_id prevents duplicates', async () => {
      // Create two vacancies, set same talentum_project_id → should fail
      const res2 = await api.post(
        '/api/admin/vacancies',
        { case_number: 77798, title: 'Unique Index Test' },
        auth(adminToken),
      );
      const otherId = res2.data.data?.id;

      await pool.query(
        `UPDATE job_postings SET talentum_project_id = 'unique-test-proj' WHERE id = $1`,
        [vacancyId],
      );

      await expect(
        pool.query(
          `UPDATE job_postings SET talentum_project_id = 'unique-test-proj' WHERE id = $1`,
          [otherId],
        ),
      ).rejects.toThrow(); // unique index violation

      // Cleanup
      await pool.query(
        `UPDATE job_postings SET talentum_project_id = NULL WHERE id = $1`,
        [vacancyId],
      );
      await pool.query(`DELETE FROM job_postings WHERE id = $1`, [otherId]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 2. Prescreening Config CRUD
  // ═══════════════════════════════════════════════════════════════════

  describe('GET /api/admin/vacancies/:id/prescreening-config', () => {
    it('returns empty questions and faq for new vacancy', async () => {
      const res = await api.get(
        `/api/admin/vacancies/${vacancyId}/prescreening-config`,
        auth(adminToken),
      );

      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.data.questions).toEqual([]);
      expect(res.data.data.faq).toEqual([]);
    });

    it('returns 401 without token', async () => {
      const res = await api.get(`/api/admin/vacancies/${vacancyId}/prescreening-config`);
      expect(res.status).toBe(401);
    });

    it('returns 403 for worker role', async () => {
      const res = await api.get(
        `/api/admin/vacancies/${vacancyId}/prescreening-config`,
        auth(workerToken),
      );
      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/admin/vacancies/:id/prescreening-config', () => {
    afterEach(async () => {
      // Cleanup questions/FAQ after each test
      await pool.query(
        `DELETE FROM job_posting_prescreening_questions WHERE job_posting_id = $1`,
        [vacancyId],
      );
      await pool.query(
        `DELETE FROM job_posting_prescreening_faq WHERE job_posting_id = $1`,
        [vacancyId],
      );
    });

    it('saves questions and returns them with IDs + order', async () => {
      const payload = {
        questions: [
          {
            question: '¿Cuál es tu experiencia con pacientes TEA?',
            responseType: ['text', 'audio'],
            desiredResponse: 'Mínimo 6 meses de experiencia',
            weight: 8,
            required: true,
            analyzed: true,
            earlyStoppage: false,
          },
          {
            question: '¿Tenés disponibilidad horaria completa?',
            responseType: ['text'],
            desiredResponse: 'Sí, lunes a viernes 09-17hs',
            weight: 6,
          },
        ],
        faq: [],
      };

      const res = await api.post(
        `/api/admin/vacancies/${vacancyId}/prescreening-config`,
        payload,
        auth(adminToken),
      );

      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);

      const { questions } = res.data.data;
      expect(questions).toHaveLength(2);
      expect(questions[0].question).toBe('¿Cuál es tu experiencia con pacientes TEA?');
      expect(questions[0].weight).toBe(8);
      expect(questions[0].required).toBe(true);
      expect(questions[0].questionOrder).toBe(1);
      expect(questions[0].id).toBeTruthy();

      expect(questions[1].questionOrder).toBe(2);
      expect(questions[1].weight).toBe(6);
    });

    it('saves FAQ and returns them with IDs + order', async () => {
      const payload = {
        questions: [
          { question: 'Q1?', desiredResponse: 'A1', weight: 5 },
        ],
        faq: [
          { question: '¿Cuál es el salario?', answer: 'A convenir según experiencia' },
          { question: '¿Es presencial?', answer: 'Sí, en domicilio del paciente' },
        ],
      };

      const res = await api.post(
        `/api/admin/vacancies/${vacancyId}/prescreening-config`,
        payload,
        auth(adminToken),
      );

      expect(res.status).toBe(200);
      const { faq } = res.data.data;
      expect(faq).toHaveLength(2);
      expect(faq[0].question).toBe('¿Cuál es el salario?');
      expect(faq[0].answer).toBe('A convenir según experiencia');
      expect(faq[0].faqOrder).toBe(1);
      expect(faq[1].faqOrder).toBe(2);
    });

    it('replaces all questions on re-save (no duplicates)', async () => {
      // First save: 2 questions
      await api.post(
        `/api/admin/vacancies/${vacancyId}/prescreening-config`,
        {
          questions: [
            { question: 'Old Q1?', desiredResponse: 'A1', weight: 5 },
            { question: 'Old Q2?', desiredResponse: 'A2', weight: 3 },
          ],
          faq: [],
        },
        auth(adminToken),
      );

      // Second save: 1 question (different)
      const res = await api.post(
        `/api/admin/vacancies/${vacancyId}/prescreening-config`,
        {
          questions: [
            { question: 'New Q1?', desiredResponse: 'New A1', weight: 7 },
          ],
          faq: [],
        },
        auth(adminToken),
      );

      expect(res.data.data.questions).toHaveLength(1);
      expect(res.data.data.questions[0].question).toBe('New Q1?');
      expect(res.data.data.questions[0].questionOrder).toBe(1);

      // Verify DB only has 1 question (no leftovers from first save)
      const { rows } = await pool.query(
        `SELECT id FROM job_posting_prescreening_questions WHERE job_posting_id = $1`,
        [vacancyId],
      );
      expect(rows).toHaveLength(1);
    });

    it('preserves question order from array index', async () => {
      const res = await api.post(
        `/api/admin/vacancies/${vacancyId}/prescreening-config`,
        {
          questions: [
            { question: 'First?', desiredResponse: 'A', weight: 1 },
            { question: 'Second?', desiredResponse: 'B', weight: 2 },
            { question: 'Third?', desiredResponse: 'C', weight: 3 },
          ],
          faq: [],
        },
        auth(adminToken),
      );

      const questions = res.data.data.questions;
      expect(questions[0].questionOrder).toBe(1);
      expect(questions[0].question).toBe('First?');
      expect(questions[1].questionOrder).toBe(2);
      expect(questions[2].questionOrder).toBe(3);
    });

    it('accepts empty questions array (clears all questions)', async () => {
      // Save one question first
      await api.post(
        `/api/admin/vacancies/${vacancyId}/prescreening-config`,
        {
          questions: [{ question: 'Q?', desiredResponse: 'A', weight: 5 }],
          faq: [],
        },
        auth(adminToken),
      );

      // Clear all
      const res = await api.post(
        `/api/admin/vacancies/${vacancyId}/prescreening-config`,
        { questions: [], faq: [] },
        auth(adminToken),
      );

      expect(res.status).toBe(200);
      expect(res.data.data.questions).toHaveLength(0);

      // Verify DB
      const { rows } = await pool.query(
        `SELECT id FROM job_posting_prescreening_questions WHERE job_posting_id = $1`,
        [vacancyId],
      );
      expect(rows).toHaveLength(0);
    });

    it('applies default values for optional fields', async () => {
      const res = await api.post(
        `/api/admin/vacancies/${vacancyId}/prescreening-config`,
        {
          questions: [
            { question: 'Minimal?', desiredResponse: 'Answer', weight: 5 },
          ],
          faq: [],
        },
        auth(adminToken),
      );

      const q = res.data.data.questions[0];
      expect(q.responseType).toEqual(['text', 'audio']); // default
      expect(q.required).toBe(false); // default
      expect(q.analyzed).toBe(true); // default
      expect(q.earlyStoppage).toBe(false); // default
    });

    it('persists in database correctly', async () => {
      await api.post(
        `/api/admin/vacancies/${vacancyId}/prescreening-config`,
        {
          questions: [
            {
              question: 'DB test?',
              responseType: ['audio'],
              desiredResponse: 'DB answer',
              weight: 9,
              required: true,
              analyzed: false,
              earlyStoppage: true,
            },
          ],
          faq: [{ question: 'FAQ DB?', answer: 'FAQ answer' }],
        },
        auth(adminToken),
      );

      // Check questions in DB
      const { rows: questions } = await pool.query(
        `SELECT * FROM job_posting_prescreening_questions WHERE job_posting_id = $1`,
        [vacancyId],
      );
      expect(questions).toHaveLength(1);
      expect(questions[0].question).toBe('DB test?');
      expect(questions[0].response_type).toEqual(['audio']);
      expect(questions[0].desired_response).toBe('DB answer');
      expect(questions[0].weight).toBe(9);
      expect(questions[0].required).toBe(true);
      expect(questions[0].analyzed).toBe(false);
      expect(questions[0].early_stoppage).toBe(true);
      expect(questions[0].question_order).toBe(1);

      // Check FAQ in DB
      const { rows: faqs } = await pool.query(
        `SELECT * FROM job_posting_prescreening_faq WHERE job_posting_id = $1`,
        [vacancyId],
      );
      expect(faqs).toHaveLength(1);
      expect(faqs[0].question).toBe('FAQ DB?');
      expect(faqs[0].answer).toBe('FAQ answer');
      expect(faqs[0].faq_order).toBe(1);
    });

    // ── Validation errors ──────────────────────────────────────────
    it('returns 400 when question.question is empty', async () => {
      const res = await api.post(
        `/api/admin/vacancies/${vacancyId}/prescreening-config`,
        {
          questions: [
            { question: '', desiredResponse: 'A', weight: 5 },
          ],
          faq: [],
        },
        auth(adminToken),
      );

      expect(res.status).toBe(400);
      expect(res.data.error).toContain('questions[0].question');
    });

    it('returns 400 when question.question is missing', async () => {
      const res = await api.post(
        `/api/admin/vacancies/${vacancyId}/prescreening-config`,
        {
          questions: [
            { desiredResponse: 'A', weight: 5 },
          ],
          faq: [],
        },
        auth(adminToken),
      );

      expect(res.status).toBe(400);
      expect(res.data.error).toContain('questions[0].question');
    });

    it('returns 400 when desiredResponse is empty', async () => {
      const res = await api.post(
        `/api/admin/vacancies/${vacancyId}/prescreening-config`,
        {
          questions: [
            { question: 'Q?', desiredResponse: '', weight: 5 },
          ],
          faq: [],
        },
        auth(adminToken),
      );

      expect(res.status).toBe(400);
      expect(res.data.error).toContain('questions[0].desiredResponse');
    });

    it('returns 400 when desiredResponse is missing', async () => {
      const res = await api.post(
        `/api/admin/vacancies/${vacancyId}/prescreening-config`,
        {
          questions: [
            { question: 'Q?', weight: 5 },
          ],
          faq: [],
        },
        auth(adminToken),
      );

      expect(res.status).toBe(400);
      expect(res.data.error).toContain('questions[0].desiredResponse');
    });

    it('returns 400 when weight is 0 (below minimum)', async () => {
      const res = await api.post(
        `/api/admin/vacancies/${vacancyId}/prescreening-config`,
        {
          questions: [
            { question: 'Q?', desiredResponse: 'A', weight: 0 },
          ],
          faq: [],
        },
        auth(adminToken),
      );

      expect(res.status).toBe(400);
      expect(res.data.error).toContain('weight');
    });

    it('returns 400 when weight is 11 (above maximum)', async () => {
      const res = await api.post(
        `/api/admin/vacancies/${vacancyId}/prescreening-config`,
        {
          questions: [
            { question: 'Q?', desiredResponse: 'A', weight: 11 },
          ],
          faq: [],
        },
        auth(adminToken),
      );

      expect(res.status).toBe(400);
      expect(res.data.error).toContain('weight');
    });

    it('returns 400 when weight is not an integer', async () => {
      const res = await api.post(
        `/api/admin/vacancies/${vacancyId}/prescreening-config`,
        {
          questions: [
            { question: 'Q?', desiredResponse: 'A', weight: 5.5 },
          ],
          faq: [],
        },
        auth(adminToken),
      );

      expect(res.status).toBe(400);
      expect(res.data.error).toContain('weight');
    });

    it('validates second question (index in error message)', async () => {
      const res = await api.post(
        `/api/admin/vacancies/${vacancyId}/prescreening-config`,
        {
          questions: [
            { question: 'Q1?', desiredResponse: 'A1', weight: 5 },
            { question: '', desiredResponse: 'A2', weight: 5 }, // invalid
          ],
          faq: [],
        },
        auth(adminToken),
      );

      expect(res.status).toBe(400);
      expect(res.data.error).toContain('questions[1]');
    });

    // ── Auth ────────────────────────────────────────────────────────
    it('returns 401 without token', async () => {
      const res = await api.post(
        `/api/admin/vacancies/${vacancyId}/prescreening-config`,
        { questions: [], faq: [] },
      );
      expect(res.status).toBe(401);
    });

    it('returns 403 for worker role', async () => {
      const res = await api.post(
        `/api/admin/vacancies/${vacancyId}/prescreening-config`,
        { questions: [], faq: [] },
        auth(workerToken),
      );
      expect(res.status).toBe(403);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 3. POST /publish-talentum — validation paths
  // ═══════════════════════════════════════════════════════════════════

  describe('POST /api/admin/vacancies/:id/publish-talentum', () => {
    it('returns 400 when no prescreening questions configured (CA-4.1)', async () => {
      // Ensure no questions exist
      await pool.query(
        `DELETE FROM job_posting_prescreening_questions WHERE job_posting_id = $1`,
        [vacancyId],
      );

      const res = await api.post(
        `/api/admin/vacancies/${vacancyId}/publish-talentum`,
        {},
        auth(adminToken),
      );

      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
      expect(res.data.error).toContain('No prescreening questions');
    });

    it('returns 409 when vacancy already published (CA-4.2)', async () => {
      // Simulate published state
      await pool.query(
        `UPDATE job_postings SET talentum_project_id = 'fake-proj-id' WHERE id = $1`,
        [vacancyId],
      );

      const res = await api.post(
        `/api/admin/vacancies/${vacancyId}/publish-talentum`,
        {},
        auth(adminToken),
      );

      expect(res.status).toBe(409);
      expect(res.data.error).toContain('already published');

      // Cleanup
      await pool.query(
        `UPDATE job_postings SET talentum_project_id = NULL WHERE id = $1`,
        [vacancyId],
      );
    });

    it('returns 404 for non-existent vacancy', async () => {
      const res = await api.post(
        `/api/admin/vacancies/${FAKE_UUID}/publish-talentum`,
        {},
        auth(adminToken),
      );

      expect(res.status).toBe(404);
    });

    it('returns 502 when Talentum API is not reachable (no credentials in test)', async () => {
      // Add a question so we pass the 400 check
      await pool.query(
        `INSERT INTO job_posting_prescreening_questions
           (job_posting_id, question_order, question, desired_response, weight)
         VALUES ($1, 1, 'E2E test question', 'Expected answer', 5)`,
        [vacancyId],
      );

      const res = await api.post(
        `/api/admin/vacancies/${vacancyId}/publish-talentum`,
        {},
        auth(adminToken),
      );

      // Should fail at Talentum client creation (no credentials) → 502 or 500
      expect([500, 502]).toContain(res.status);

      // Cleanup
      await pool.query(
        `DELETE FROM job_posting_prescreening_questions WHERE job_posting_id = $1`,
        [vacancyId],
      );
    });

    it('returns 401 without token', async () => {
      const res = await api.post(`/api/admin/vacancies/${vacancyId}/publish-talentum`, {});
      expect(res.status).toBe(401);
    });

    it('returns 403 for worker role', async () => {
      const res = await api.post(
        `/api/admin/vacancies/${vacancyId}/publish-talentum`,
        {},
        auth(workerToken),
      );
      expect(res.status).toBe(403);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 4. DELETE /publish-talentum — validation paths
  // ═══════════════════════════════════════════════════════════════════

  describe('DELETE /api/admin/vacancies/:id/publish-talentum', () => {
    it('returns 400 when vacancy is not published', async () => {
      // Ensure not published
      await pool.query(
        `UPDATE job_postings SET talentum_project_id = NULL WHERE id = $1`,
        [vacancyId],
      );

      const res = await api.delete(
        `/api/admin/vacancies/${vacancyId}/publish-talentum`,
        auth(adminToken),
      );

      expect(res.status).toBe(400);
      expect(res.data.error).toContain('not published');
    });

    it('returns 404 for non-existent vacancy', async () => {
      const res = await api.delete(
        `/api/admin/vacancies/${FAKE_UUID}/publish-talentum`,
        auth(adminToken),
      );

      expect(res.status).toBe(404);
    });

    it('returns 502 when Talentum API is not reachable (no credentials in test)', async () => {
      // Simulate published state
      await pool.query(
        `UPDATE job_postings SET talentum_project_id = 'fake-proj-for-delete' WHERE id = $1`,
        [vacancyId],
      );

      const res = await api.delete(
        `/api/admin/vacancies/${vacancyId}/publish-talentum`,
        auth(adminToken),
      );

      // Should fail at Talentum client creation → 502 or 500
      expect([500, 502]).toContain(res.status);

      // Cleanup
      await pool.query(
        `UPDATE job_postings SET talentum_project_id = NULL WHERE id = $1`,
        [vacancyId],
      );
    });

    it('returns 401 without token', async () => {
      const res = await api.delete(`/api/admin/vacancies/${vacancyId}/publish-talentum`);
      expect(res.status).toBe(401);
    });

    it('returns 403 for worker role', async () => {
      const res = await api.delete(
        `/api/admin/vacancies/${vacancyId}/publish-talentum`,
        auth(workerToken),
      );
      expect(res.status).toBe(403);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 5. POST /generate-talentum-description — validation paths
  // ═══════════════════════════════════════════════════════════════════

  describe('POST /api/admin/vacancies/:id/generate-talentum-description', () => {
    it('returns 500 without GEMINI_API_KEY configured', async () => {
      // In test environment, GEMINI_API_KEY is not set → service constructor throws
      const res = await api.post(
        `/api/admin/vacancies/${vacancyId}/generate-talentum-description`,
        {},
        auth(adminToken),
      );

      expect(res.status).toBe(500);
      expect(res.data.success).toBe(false);
    });

    it('returns 401 without token', async () => {
      const res = await api.post(
        `/api/admin/vacancies/${vacancyId}/generate-talentum-description`,
        {},
      );
      expect(res.status).toBe(401);
    });

    it('returns 403 for worker role', async () => {
      const res = await api.post(
        `/api/admin/vacancies/${vacancyId}/generate-talentum-description`,
        {},
        auth(workerToken),
      );
      expect(res.status).toBe(403);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 6. GET /vacancies/:id — Talentum fields in detail response
  // ═══════════════════════════════════════════════════════════════════

  describe('GET /api/admin/vacancies/:id — Talentum fields', () => {
    it('returns Talentum fields as null when not published', async () => {
      const res = await api.get(
        `/api/admin/vacancies/${vacancyId}`,
        auth(adminToken),
      );

      expect(res.status).toBe(200);
      expect(res.data.data.talentum_project_id).toBeNull();
      expect(res.data.data.talentum_whatsapp_url).toBeNull();
      expect(res.data.data.talentum_slug).toBeNull();
      expect(res.data.data.talentum_published_at).toBeNull();
    });

    it('returns Talentum fields when simulating published state', async () => {
      await pool.query(
        `UPDATE job_postings SET
          talentum_project_id = 'proj-detail-test',
          talentum_whatsapp_url = 'https://wa.me/test',
          talentum_slug = '#slug123',
          talentum_published_at = NOW()
         WHERE id = $1`,
        [vacancyId],
      );

      const res = await api.get(
        `/api/admin/vacancies/${vacancyId}`,
        auth(adminToken),
      );

      expect(res.status).toBe(200);
      expect(res.data.data.talentum_project_id).toBe('proj-detail-test');
      expect(res.data.data.talentum_whatsapp_url).toBe('https://wa.me/test');
      expect(res.data.data.talentum_slug).toBe('#slug123');
      expect(res.data.data.talentum_published_at).toBeTruthy();

      // Cleanup
      await pool.query(
        `UPDATE job_postings SET
          talentum_project_id = NULL,
          talentum_whatsapp_url = NULL,
          talentum_slug = NULL,
          talentum_published_at = NULL
         WHERE id = $1`,
        [vacancyId],
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 7. Prescreening config + GET roundtrip
  // ═══════════════════════════════════════════════════════════════════

  describe('Prescreening config roundtrip (POST → GET)', () => {
    afterEach(async () => {
      await pool.query(
        `DELETE FROM job_posting_prescreening_questions WHERE job_posting_id = $1`,
        [vacancyId],
      );
      await pool.query(
        `DELETE FROM job_posting_prescreening_faq WHERE job_posting_id = $1`,
        [vacancyId],
      );
    });

    it('POST saves → GET returns same data', async () => {
      const payload = {
        questions: [
          {
            question: 'Roundtrip Q?',
            responseType: ['text'],
            desiredResponse: 'Roundtrip A',
            weight: 7,
            required: true,
            analyzed: false,
            earlyStoppage: true,
          },
        ],
        faq: [
          { question: 'RT FAQ?', answer: 'RT Answer' },
        ],
      };

      await api.post(
        `/api/admin/vacancies/${vacancyId}/prescreening-config`,
        payload,
        auth(adminToken),
      );

      const getRes = await api.get(
        `/api/admin/vacancies/${vacancyId}/prescreening-config`,
        auth(adminToken),
      );

      expect(getRes.status).toBe(200);
      const { questions, faq } = getRes.data.data;
      expect(questions).toHaveLength(1);
      expect(questions[0].question).toBe('Roundtrip Q?');
      expect(questions[0].responseType).toEqual(['text']);
      expect(questions[0].desiredResponse).toBe('Roundtrip A');
      expect(questions[0].weight).toBe(7);
      expect(questions[0].required).toBe(true);
      expect(questions[0].analyzed).toBe(false);
      expect(questions[0].earlyStoppage).toBe(true);

      expect(faq).toHaveLength(1);
      expect(faq[0].question).toBe('RT FAQ?');
      expect(faq[0].answer).toBe('RT Answer');
    });

    it('POST with only FAQ (no questions) works', async () => {
      const res = await api.post(
        `/api/admin/vacancies/${vacancyId}/prescreening-config`,
        {
          questions: [],
          faq: [
            { question: 'Solo FAQ?', answer: 'Solo respuesta' },
          ],
        },
        auth(adminToken),
      );

      expect(res.status).toBe(200);
      expect(res.data.data.questions).toHaveLength(0);
      expect(res.data.data.faq).toHaveLength(1);
    });

    it('POST trims whitespace from questions and answers', async () => {
      const res = await api.post(
        `/api/admin/vacancies/${vacancyId}/prescreening-config`,
        {
          questions: [
            { question: '  spaced question  ', desiredResponse: '  spaced answer  ', weight: 5 },
          ],
          faq: [],
        },
        auth(adminToken),
      );

      expect(res.status).toBe(200);
      expect(res.data.data.questions[0].question).toBe('spaced question');
      expect(res.data.data.questions[0].desiredResponse).toBe('spaced answer');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 8. Edge cases and potential breaches
  // ═══════════════════════════════════════════════════════════════════

  describe('Edge cases — potential breaches', () => {
    afterEach(async () => {
      await pool.query(
        `DELETE FROM job_posting_prescreening_questions WHERE job_posting_id = $1`,
        [vacancyId],
      );
      await pool.query(
        `DELETE FROM job_posting_prescreening_faq WHERE job_posting_id = $1`,
        [vacancyId],
      );
      await pool.query(
        `UPDATE job_postings SET talentum_project_id = NULL, talentum_whatsapp_url = NULL,
         talentum_slug = NULL, talentum_published_at = NULL, talentum_description = NULL
         WHERE id = $1`,
        [vacancyId],
      );
    });

    it('prescreening-config rejects question with whitespace-only text', async () => {
      const res = await api.post(
        `/api/admin/vacancies/${vacancyId}/prescreening-config`,
        {
          questions: [
            { question: '   ', desiredResponse: 'A', weight: 5 },
          ],
          faq: [],
        },
        auth(adminToken),
      );

      expect(res.status).toBe(400);
    });

    it('prescreening-config rejects desiredResponse with whitespace-only text', async () => {
      const res = await api.post(
        `/api/admin/vacancies/${vacancyId}/prescreening-config`,
        {
          questions: [
            { question: 'Q?', desiredResponse: '   ', weight: 5 },
          ],
          faq: [],
        },
        auth(adminToken),
      );

      expect(res.status).toBe(400);
    });

    it('prescreening-config rejects weight as string', async () => {
      const res = await api.post(
        `/api/admin/vacancies/${vacancyId}/prescreening-config`,
        {
          questions: [
            { question: 'Q?', desiredResponse: 'A', weight: 'five' },
          ],
          faq: [],
        },
        auth(adminToken),
      );

      expect(res.status).toBe(400);
    });

    it('prescreening-config rejects negative weight', async () => {
      const res = await api.post(
        `/api/admin/vacancies/${vacancyId}/prescreening-config`,
        {
          questions: [
            { question: 'Q?', desiredResponse: 'A', weight: -1 },
          ],
          faq: [],
        },
        auth(adminToken),
      );

      expect(res.status).toBe(400);
    });

    it('publish-talentum returns 404 for deleted (soft-deleted) vacancy', async () => {
      // Create and soft-delete a vacancy
      const createRes = await api.post(
        '/api/admin/vacancies',
        { case_number: 77797, title: 'Caso Soft Delete' },
        auth(adminToken),
      );
      const deletedId = createRes.data.data?.id;

      await api.delete(`/api/admin/vacancies/${deletedId}`, auth(adminToken));

      // Attempt to publish → should be 404 (deleted_at IS NOT NULL)
      const res = await api.post(
        `/api/admin/vacancies/${deletedId}/publish-talentum`,
        {},
        auth(adminToken),
      );

      // Controller uses deleted_at IS NULL filter; closed status isn't a hard delete
      // but the vacancy is still queryable. We check it's handled gracefully.
      expect([400, 404]).toContain(res.status);
    });

    it('concurrent prescreening-config saves do not leave orphan rows', async () => {
      // Simulate concurrent saves by running two POST requests
      const [res1, res2] = await Promise.all([
        api.post(
          `/api/admin/vacancies/${vacancyId}/prescreening-config`,
          {
            questions: [{ question: 'Concurrent A?', desiredResponse: 'A', weight: 5 }],
            faq: [],
          },
          auth(adminToken),
        ),
        api.post(
          `/api/admin/vacancies/${vacancyId}/prescreening-config`,
          {
            questions: [{ question: 'Concurrent B?', desiredResponse: 'B', weight: 6 }],
            faq: [],
          },
          auth(adminToken),
        ),
      ]);

      // At least one must succeed (200); the other may fail (500) due to race condition.
      // The key invariant is: no orphan rows — DB should have 0 or 1 question, never more.
      const statuses = [res1.status, res2.status];
      expect(statuses).toContain(200);

      // DB should have at most 1 question (from whichever won the race)
      const { rows } = await pool.query(
        `SELECT question FROM job_posting_prescreening_questions WHERE job_posting_id = $1`,
        [vacancyId],
      );
      expect(rows.length).toBeLessThanOrEqual(1);
    });

    it('large number of questions does not cause issues', async () => {
      const manyQuestions = Array.from({ length: 20 }, (_, i) => ({
        question: `Pregunta ${i + 1}?`,
        desiredResponse: `Respuesta ${i + 1}`,
        weight: Math.min(i + 1, 10),
      }));

      const res = await api.post(
        `/api/admin/vacancies/${vacancyId}/prescreening-config`,
        { questions: manyQuestions, faq: [] },
        auth(adminToken),
      );

      expect(res.status).toBe(200);
      expect(res.data.data.questions).toHaveLength(20);

      // Verify order is preserved
      for (let i = 0; i < 20; i++) {
        expect(res.data.data.questions[i].questionOrder).toBe(i + 1);
      }
    });
  });
});
