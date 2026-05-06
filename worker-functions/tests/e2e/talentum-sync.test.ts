/**
 * talentum-sync.test.ts — E2E Tests
 *
 * Tests the POST /api/admin/vacancies/sync-talentum endpoint.
 *
 * Since this endpoint calls external services (Talentum API, Gemini) that are
 * NOT available in the E2E environment, we test:
 *
 *   1. Auth/permissions — requires admin (requireStaff), rejects worker/anon
 *   2. Route exists and responds correctly
 *   3. Error handling — returns 5xx when external services unavailable
 *   4. DB-level validation — sync-created vacancies have correct schema
 *   5. Direct DB simulation — insert vacancy as if sync created it, verify fields
 *
 * The full integration (Talentum → Gemini → DB) is covered by unit tests
 * with mocks in SyncTalentumVacanciesUseCase.test.ts.
 */

import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('Talentum Sync API', () => {
  const api = createApiClient();
  let adminToken: string;
  let workerToken: string;
  let pool: Pool;

  beforeAll(async () => {
    await waitForBackend(api);

    adminToken = await getMockToken(api, {
      uid: 'sync-admin-e2e',
      email: 'sync-admin@e2e.local',
      role: 'admin',
    });

    workerToken = await getMockToken(api, {
      uid: 'sync-worker-e2e',
      email: 'sync-worker@e2e.local',
      role: 'worker',
    });

    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    // Cleanup test data
    await pool.query(
      `DELETE FROM job_postings WHERE case_number IN (88801, 88802, 88803)`,
    ).catch(() => {});
    if (pool) await pool.end();
  });

  function auth(token: string) {
    return { headers: { Authorization: `Bearer ${token}` } };
  }

  // ���══════════════════════════════════════════════════════════════════
  // 1. Auth/permissions
  // ══════════════════════════════════���════════════════════════════════

  describe('POST /api/admin/vacancies/sync-talentum — auth', () => {
    it('returns 401 without token', async () => {
      const res = await api.post('/api/admin/vacancies/sync-talentum');
      expect(res.status).toBe(401);
    });

    it('returns 403 for worker role', async () => {
      const res = await api.post(
        '/api/admin/vacancies/sync-talentum',
        {},
        auth(workerToken),
      );
      expect(res.status).toBe(403);
    });

    it('admin can reach the endpoint (responds with 5xx due to missing Talentum creds)', async () => {
      const res = await api.post(
        '/api/admin/vacancies/sync-talentum',
        {},
        auth(adminToken),
      );

      // The endpoint is reachable but fails because Talentum API credentials
      // are not configured in E2E environment → 500 or 502
      expect([500, 502]).toContain(res.status);
      expect(res.data.success).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 2. Error handling — response format
  // ═════════════════════════════════════════════���═════════════════════

  describe('POST /api/admin/vacancies/sync-talentum — error format', () => {
    it('returns JSON with success=false and error message', async () => {
      const res = await api.post(
        '/api/admin/vacancies/sync-talentum',
        {},
        auth(adminToken),
      );

      expect(res.data).toHaveProperty('success', false);
      expect(res.data).toHaveProperty('error');
      expect(typeof res.data.error).toBe('string');
    });

    it('includes details in error response', async () => {
      const res = await api.post(
        '/api/admin/vacancies/sync-talentum',
        {},
        auth(adminToken),
      );

      expect(res.data).toHaveProperty('details');
      expect(typeof res.data.details).toBe('string');
    });
  });

  // ═══════════════════════════════════��═══════════════════════════════
  // 3. DB-level: sync-created vacancy schema validation
  // ══════════════���═════════════════════════════════��══════════════════

  describe('Sync-created vacancy — DB schema', () => {
    let syncedVacancyId: string;

    beforeAll(async () => {
      // Simulate a vacancy created by the sync process (same INSERT as SyncTalentumVacanciesUseCase.createFromSync)
      // Note: pathology_types, dependency_level, service_device_types, city, state
      // were dropped in migration 152 — those fields now live in patients / patient_addresses.
      const result = await pool.query(
        `INSERT INTO job_postings (
           case_number, title, description, country, status,
           required_professions, required_sex,
           age_range_min, age_range_max,
           required_experience, worker_attributes,
           schedule, work_schedule,
           providers_needed, salary_text, payment_day,
           daily_obs
         ) VALUES (
           $1, $2, '', 'AR', 'SEARCHING',
           $3, $4, $5, $6, $7, $8, $9, $10,
           $11, $12, $13, $14
         )
         RETURNING id`,
        [
          88801,
          'CASO 88801',
          ['AT'],         // required_professions
          'M',            // required_sex
          null,           // age_range_min
          null,           // age_range_max
          'experiencia con bipolaridad',
          null,           // worker_attributes
          JSON.stringify([{ dayOfWeek: 1, startTime: '17:00', endTime: '23:00' }]),
          'part-time',
          1,              // providers_needed
          'A convenir',
          null,           // payment_day
          null,           // daily_obs
        ],
      );
      syncedVacancyId = result.rows[0].id;
    });

    afterAll(async () => {
      await pool.query('DELETE FROM job_postings WHERE id = $1', [syncedVacancyId]).catch(() => {});
    });

    it('vacancy is created with correct case_number and title', async () => {
      const { rows } = await pool.query(
        'SELECT case_number, title FROM job_postings WHERE id = $1',
        [syncedVacancyId],
      );

      expect(rows[0].case_number).toBe(88801);
      expect(rows[0].title).toBe('CASO 88801');
    });

    it('vacancy has country=AR and status=SEARCHING', async () => {
      const { rows } = await pool.query(
        'SELECT country, status FROM job_postings WHERE id = $1',
        [syncedVacancyId],
      );

      expect(rows[0].country).toBe('AR');
      expect(rows[0].status).toBe('SEARCHING');
    });

    it('vacancy has structured fields correctly stored', async () => {
      // Note: pathology_types, city, state, service_device_types, dependency_level
      // were dropped in migration 152 — clinical/location data lives in patients / patient_addresses.
      const { rows } = await pool.query(
        `SELECT required_professions, required_sex, schedule, work_schedule
         FROM job_postings WHERE id = $1`,
        [syncedVacancyId],
      );

      expect(rows[0].required_professions).toEqual(['AT']);
      expect(rows[0].required_sex).toBe('M');
      expect(rows[0].schedule).toEqual([{ dayOfWeek: 1, startTime: '17:00', endTime: '23:00' }]);
      expect(rows[0].work_schedule).toBe('part-time');
    });

    it('nullable fields are null when not provided', async () => {
      const { rows } = await pool.query(
        `SELECT age_range_min, age_range_max, worker_attributes,
                payment_day, daily_obs
         FROM job_postings WHERE id = $1`,
        [syncedVacancyId],
      );

      expect(rows[0].age_range_min).toBeNull();
      expect(rows[0].age_range_max).toBeNull();
      expect(rows[0].worker_attributes).toBeNull();
      expect(rows[0].payment_day).toBeNull();
      expect(rows[0].daily_obs).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 4. DB-level: update only non-null fields (sync update simulation)
  // ═══════════════════════════════════════════════════════════════════

  describe('Sync update — non-null fields only', () => {
    let existingVacancyId: string;

    beforeAll(async () => {
      // Create vacancy with initial data
      // Note: city, state, pathology_types, service_device_types dropped in migration 152.
      const result = await pool.query(
        `INSERT INTO job_postings (
           case_number, title, description, country, status,
           required_professions, required_sex,
           salary_text, providers_needed
         ) VALUES (
           88802, 'CASO 88802', '', 'AR', 'SEARCHING',
           '{AT}', 'F', '50000 ARS', 2
         )
         RETURNING id`,
      );
      existingVacancyId = result.rows[0].id;
    });

    afterAll(async () => {
      await pool.query('DELETE FROM job_postings WHERE id = $1', [existingVacancyId]).catch(() => {});
    });

    it('update only overwrites non-null fields, preserves existing values', async () => {
      // Simulate what SyncTalentumVacanciesUseCase.updateFromSync does:
      // Only update work_schedule (the rest would be null from LLM).
      // Note: city, state, pathology_types, service_device_types dropped in migration 152.
      await pool.query(
        `UPDATE job_postings
         SET work_schedule = $1, updated_at = NOW()
         WHERE id = $2`,
        ['full-time', existingVacancyId],
      );

      const { rows } = await pool.query(
        `SELECT work_schedule, required_sex, salary_text,
                providers_needed, required_professions
         FROM job_postings WHERE id = $1`,
        [existingVacancyId],
      );

      // Updated field
      expect(rows[0].work_schedule).toBe('full-time');

      // Preserved fields (not overwritten with null)
      expect(rows[0].required_sex).toBe('F');
      expect(rows[0].salary_text).toBe('50000 ARS');
      // providers_needed is TEXT in the DB — returns string value
      expect(String(rows[0].providers_needed)).toBe('2');
      expect(rows[0].required_professions).toEqual(['AT']);
    });
  });

  // ════════��══════════════════════════��═══════════════════════════════
  // 5. DB-level: Talentum reference columns
  // ═══════════════���═══════════════════════════════���═══════════════════

  describe('Talentum reference columns', () => {
    let refVacancyId: string;

    beforeAll(async () => {
      const result = await pool.query(
        `INSERT INTO job_postings (case_number, title, description, country, status)
         VALUES (88803, 'CASO 88803', '', 'AR', 'SEARCHING')
         RETURNING id`,
      );
      refVacancyId = result.rows[0].id;
    });

    afterAll(async () => {
      await pool.query('DELETE FROM job_postings WHERE id = $1', [refVacancyId]).catch(() => {});
    });

    it('saves Talentum reference columns correctly', async () => {
      // Simulate saveTalentumReference
      await pool.query(
        `UPDATE job_postings
         SET talentum_project_id   = $1,
             talentum_public_id    = $2,
             talentum_whatsapp_url = $3,
             talentum_slug         = $4,
             talentum_published_at = $5,
             talentum_description  = $6,
             updated_at            = NOW()
         WHERE id = $7`,
        [
          'proj-e2e-sync',
          'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',  // valid UUID for talentum_public_id (UUID type)
          'https://wa.me/talentum/proj-e2e-sync',
          'caso-88803-at',
          '2025-06-01T12:00:00Z',
          'Descripcion completa de la Talentum...',
          refVacancyId,
        ],
      );

      const { rows } = await pool.query(
        `SELECT talentum_project_id, talentum_public_id, talentum_whatsapp_url,
                talentum_slug, talentum_published_at, talentum_description
         FROM job_postings WHERE id = $1`,
        [refVacancyId],
      );

      expect(rows[0].talentum_project_id).toBe('proj-e2e-sync');
      expect(rows[0].talentum_public_id).toBe('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');
      expect(rows[0].talentum_whatsapp_url).toBe('https://wa.me/talentum/proj-e2e-sync');
      expect(rows[0].talentum_slug).toBe('caso-88803-at');
      expect(rows[0].talentum_published_at).toBeTruthy();
      expect(rows[0].talentum_description).toBe('Descripcion completa de la Talentum...');
    });

    it('Talentum reference columns are nullable (initially null)', async () => {
      // Create a fresh vacancy without references
      const { rows: [fresh] } = await pool.query(
        `SELECT talentum_project_id, talentum_public_id, talentum_whatsapp_url
         FROM job_postings
         WHERE case_number = 88803 AND talentum_project_id IS NOT NULL`,
      );

      // We set them above, so clear and verify they accept null
      await pool.query(
        `UPDATE job_postings
         SET talentum_project_id = NULL, talentum_public_id = NULL,
             talentum_whatsapp_url = NULL, talentum_slug = NULL,
             talentum_published_at = NULL, talentum_description = NULL
         WHERE id = $1`,
        [refVacancyId],
      );

      const { rows } = await pool.query(
        `SELECT talentum_project_id, talentum_public_id, talentum_whatsapp_url
         FROM job_postings WHERE id = $1`,
        [refVacancyId],
      );

      expect(rows[0].talentum_project_id).toBeNull();
      expect(rows[0].talentum_public_id).toBeNull();
      expect(rows[0].talentum_whatsapp_url).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 6. Endpoint response structure (when it fails due to env)
  // ════════════��═════════════════════════════════���════════════════════

  describe('Response structure', () => {
    it('returns JSON content-type', async () => {
      const res = await api.post(
        '/api/admin/vacancies/sync-talentum',
        {},
        auth(adminToken),
      );

      expect(res.headers['content-type']).toContain('application/json');
    });

    it('response has success and error fields on failure', async () => {
      const res = await api.post(
        '/api/admin/vacancies/sync-talentum',
        {},
        auth(adminToken),
      );

      expect(typeof res.data.success).toBe('boolean');
      expect(res.data.success).toBe(false);
      expect(typeof res.data.error).toBe('string');
    });
  });
});
