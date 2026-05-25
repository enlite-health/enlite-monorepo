/**
 * sync-talentum-workers.test.ts — E2E Tests
 *
 * Tests the POST /api/admin/workers/sync-talentum endpoint.
 *
 * Since the endpoint calls the Talentum dashboard API which is NOT available
 * in the E2E environment, we test:
 *
 *   1. Auth/permissions — requires admin (requireStaff), rejects worker/anon
 *   2. Route exists and responds correctly
 *   3. Error handling — returns 5xx when Talentum creds unavailable
 *   4. DB-level validation — simulated sync creates workers with correct schema
 *   5. DB-level: fill missing data without overwriting existing
 *   6. DB-level: worker_job_applications + encuadres creation
 *
 * The full integration (Talentum Dashboard → DB) is covered by unit tests
 * with mocks in SyncTalentumWorkersUseCase.test.ts.
 */

import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('Talentum Workers Sync API', () => {
  const api = createApiClient();
  let adminToken: string;
  let workerToken: string;
  let pool: Pool;

  beforeAll(async () => {
    await waitForBackend(api);

    adminToken = await getMockToken(api, {
      uid: 'sync-workers-admin-e2e',
      email: 'sync-workers-admin@e2e.local',
      role: 'admin',
    });

    workerToken = await getMockToken(api, {
      uid: 'sync-workers-worker-e2e',
      email: 'sync-workers-worker@e2e.local',
      role: 'worker',
    });

    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    // Cleanup test data
    await pool.query(
      `DELETE FROM encuadres WHERE dedup_hash LIKE 'e2e-sync-%'`,
    ).catch(() => {});
    await pool.query(
      `DELETE FROM worker_job_applications WHERE source = 'e2e-sync-test'`,
    ).catch(() => {});
    await pool.query(
      `DELETE FROM workers WHERE auth_uid LIKE 'talentum_e2e-%'`,
    ).catch(() => {});
    await pool.query(
      `DELETE FROM job_postings WHERE case_number IN (99901, 99902)`,
    ).catch(() => {});
    if (pool) await pool.end();
  });

  function auth(token: string) {
    return { headers: { Authorization: `Bearer ${token}` } };
  }

  // ═══════════════════════════════════════════════════════════════════
  // 1. Auth/permissions
  // ═══════════════════════════════════════════════════════════════════

  describe('POST /api/admin/workers/sync-talentum — auth', () => {
    it('returns 401 without token', async () => {
      const res = await api.post('/api/admin/workers/sync-talentum');
      expect(res.status).toBe(401);
    });

    it('returns 403 for worker role', async () => {
      const res = await api.post(
        '/api/admin/workers/sync-talentum',
        {},
        auth(workerToken),
      );
      expect(res.status).toBe(403);
    });

    it('admin can reach the endpoint (responds with 5xx due to missing Talentum creds)', async () => {
      const res = await api.post(
        '/api/admin/workers/sync-talentum',
        {},
        auth(adminToken),
      );

      // In test environments, the endpoint short-circuits to 503 before touching
      // GoogleAuth (which has no ADC in CI). In production it returns 500/502 when
      // Talentum credentials are unavailable.
      expect([500, 502, 503]).toContain(res.status);
      expect(res.data.success).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 2. Error handling — response format
  // ═══════════════════════════════════════════════════════════════════

  describe('POST /api/admin/workers/sync-talentum — error format', () => {
    it('returns JSON with success=false and error message', async () => {
      const res = await api.post(
        '/api/admin/workers/sync-talentum',
        {},
        auth(adminToken),
      );

      expect(res.data).toHaveProperty('success', false);
      expect(res.data).toHaveProperty('error');
      expect(typeof res.data.error).toBe('string');
    });

    it('returns JSON content-type', async () => {
      const res = await api.post(
        '/api/admin/workers/sync-talentum',
        {},
        auth(adminToken),
      );

      expect(res.headers['content-type']).toContain('application/json');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 3. DB-level: worker creation schema validation
  // ═══════════════════════════════════════════════════════════════════

  describe('Worker creation — DB schema', () => {
    let syncedWorkerId: string;

    beforeAll(async () => {
      // Simulate a worker created by the sync process (same INSERT as SyncTalentumWorkersUseCase)
      const result = await pool.query(
        `INSERT INTO workers (auth_uid, email, phone, first_name_encrypted, last_name_encrypted, status, country)
         VALUES ($1, $2, $3, $4, $5, 'INCOMPLETE_REGISTER', 'AR')
         RETURNING id`,
        ['talentum_e2e-create-1', 'e2e-sync-create@test.com', '5491151265663', 'enc-name', 'enc-last'],
      );
      syncedWorkerId = result.rows[0].id;
    });

    afterAll(async () => {
      await pool.query('DELETE FROM workers WHERE id = $1', [syncedWorkerId]).catch(() => {});
    });

    it('worker is created with correct auth_uid pattern', async () => {
      const { rows } = await pool.query(
        'SELECT auth_uid FROM workers WHERE id = $1',
        [syncedWorkerId],
      );
      expect(rows[0].auth_uid).toBe('talentum_e2e-create-1');
    });

    it('worker has status=INCOMPLETE_REGISTER and country=AR', async () => {
      const { rows } = await pool.query(
        'SELECT status, country FROM workers WHERE id = $1',
        [syncedWorkerId],
      );
      expect(rows[0].status).toBe('INCOMPLETE_REGISTER');
      expect(rows[0].country).toBe('AR');
    });

    it('worker has email and phone stored correctly', async () => {
      const { rows } = await pool.query(
        'SELECT email, phone FROM workers WHERE id = $1',
        [syncedWorkerId],
      );
      expect(rows[0].email).toBe('e2e-sync-create@test.com');
      expect(rows[0].phone).toBe('5491151265663');
    });

    it('worker has encrypted name fields', async () => {
      const { rows } = await pool.query(
        'SELECT first_name_encrypted, last_name_encrypted FROM workers WHERE id = $1',
        [syncedWorkerId],
      );
      expect(rows[0].first_name_encrypted).toBe('enc-name');
      expect(rows[0].last_name_encrypted).toBe('enc-last');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 4. DB-level: fill missing data without overwriting
  // ═══════════════════════════════════════════════════════════════════

  describe('Fill missing data — DB validation', () => {
    let existingWorkerId: string;

    beforeAll(async () => {
      // Create worker with partial data (no phone, no name)
      const result = await pool.query(
        `INSERT INTO workers (auth_uid, email, status, country)
         VALUES ($1, $2, 'INCOMPLETE_REGISTER', 'AR')
         RETURNING id`,
        ['talentum_e2e-fill-1', 'e2e-sync-fill@test.com'],
      );
      existingWorkerId = result.rows[0].id;
    });

    afterAll(async () => {
      await pool.query('DELETE FROM workers WHERE id = $1', [existingWorkerId]).catch(() => {});
    });

    it('can fill missing phone without overwriting email', async () => {
      // Simulate fillMissingData: update only phone (COALESCE pattern)
      await pool.query(
        `UPDATE workers SET phone = COALESCE(NULLIF(phone, ''), $1), updated_at = NOW() WHERE id = $2`,
        ['5491199887766', existingWorkerId],
      );

      const { rows } = await pool.query(
        'SELECT email, phone FROM workers WHERE id = $1',
        [existingWorkerId],
      );

      expect(rows[0].email).toBe('e2e-sync-fill@test.com'); // preserved
      expect(rows[0].phone).toBe('5491199887766');            // filled
    });

    it('COALESCE preserves existing phone when not null', async () => {
      // Try to overwrite phone using same pattern — should keep existing
      await pool.query(
        `UPDATE workers SET phone = COALESCE(NULLIF(phone, ''), $1), updated_at = NOW() WHERE id = $2`,
        ['9999999999', existingWorkerId],
      );

      const { rows } = await pool.query(
        'SELECT phone FROM workers WHERE id = $1',
        [existingWorkerId],
      );

      expect(rows[0].phone).toBe('5491199887766'); // NOT overwritten
    });

    it('can fill missing encrypted name fields', async () => {
      await pool.query(
        `UPDATE workers SET
           first_name_encrypted = COALESCE(NULLIF(first_name_encrypted, ''), $1),
           last_name_encrypted = COALESCE(NULLIF(last_name_encrypted, ''), $2),
           updated_at = NOW()
         WHERE id = $3`,
        ['enc-first', 'enc-last', existingWorkerId],
      );

      const { rows } = await pool.query(
        'SELECT first_name_encrypted, last_name_encrypted FROM workers WHERE id = $1',
        [existingWorkerId],
      );

      expect(rows[0].first_name_encrypted).toBe('enc-first');
      expect(rows[0].last_name_encrypted).toBe('enc-last');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 5. DB-level: worker_job_applications + encuadres
  // ═══════════════════════════════════════════════════════════════════

  describe('Worker-case linking — DB validation', () => {
    let workerId: string;
    let jobPostingId: string;

    beforeAll(async () => {
      // Create test worker
      const wResult = await pool.query(
        `INSERT INTO workers (auth_uid, email, phone, status, country)
         VALUES ($1, $2, $3, 'INCOMPLETE_REGISTER', 'AR')
         RETURNING id`,
        ['talentum_e2e-link-1', 'e2e-sync-link@test.com', '5491100000000'],
      );
      workerId = wResult.rows[0].id;

      // Create test job_posting
      const jpResult = await pool.query(
        `INSERT INTO job_postings (case_number, title, description, country, status)
         VALUES ($1, $2, '', 'AR', 'SEARCHING')
         RETURNING id`,
        [99901, 'CASO 99901'],
      );
      jobPostingId = jpResult.rows[0].id;
    });

    afterAll(async () => {
      await pool.query('DELETE FROM encuadres WHERE worker_id = $1', [workerId]).catch(() => {});
      await pool.query('DELETE FROM worker_job_applications WHERE worker_id = $1', [workerId]).catch(() => {});
      await pool.query('DELETE FROM workers WHERE id = $1', [workerId]).catch(() => {});
      await pool.query('DELETE FROM job_postings WHERE id = $1', [jobPostingId]).catch(() => {});
    });

    it('creates worker_job_application with funnel stage INVITED (sync sets INVITED explicitly)', async () => {
      // After migration 187: sync sets application_funnel_stage = 'INVITED' explicitly.
      // INVITED = worker detected in Talentum dashboard, no evidence of WhatsApp entry.
      await pool.query(
        `INSERT INTO worker_job_applications
           (worker_id, job_posting_id, application_funnel_stage, source)
         VALUES ($1, $2, 'INVITED', 'talentum')
         ON CONFLICT (worker_id, job_posting_id) DO NOTHING`,
        [workerId, jobPostingId],
      );

      const { rows } = await pool.query(
        `SELECT application_funnel_stage, source
         FROM worker_job_applications
         WHERE worker_id = $1 AND job_posting_id = $2`,
        [workerId, jobPostingId],
      );

      expect(rows[0].application_funnel_stage).toBe('INVITED');
      expect(rows[0].source).toBe('talentum');
    });

    it('ON CONFLICT DO NOTHING preserves existing record', async () => {
      // Try to insert again — should not create duplicate
      await pool.query(
        `INSERT INTO worker_job_applications
           (worker_id, job_posting_id, application_funnel_stage, source)
         VALUES ($1, $2, 'INVITED', 'talentum')
         ON CONFLICT (worker_id, job_posting_id) DO NOTHING`,
        [workerId, jobPostingId],
      );

      const { rows } = await pool.query(
        `SELECT application_funnel_stage FROM worker_job_applications
         WHERE worker_id = $1 AND job_posting_id = $2`,
        [workerId, jobPostingId],
      );

      expect(rows[0].application_funnel_stage).toBe('INVITED'); // preserved
    });

    it('creates encuadre with Talentum origen and dedup_hash', async () => {
      const dedupHash = 'e2e-sync-test-hash';

      await pool.query(
        `INSERT INTO encuadres (worker_id, job_posting_id, worker_raw_name, worker_raw_phone, origen, dedup_hash)
         VALUES ($1, $2, $3, $4, 'Talentum', $5)
         ON CONFLICT (dedup_hash) DO UPDATE SET
           worker_id = COALESCE(encuadres.worker_id, EXCLUDED.worker_id), updated_at = NOW()`,
        [workerId, jobPostingId, 'María González', '+5491100000000', dedupHash],
      );

      const { rows } = await pool.query(
        `SELECT worker_id, job_posting_id, worker_raw_name, origen, dedup_hash
         FROM encuadres WHERE dedup_hash = $1`,
        [dedupHash],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].worker_id).toBe(workerId);
      expect(rows[0].job_posting_id).toBe(jobPostingId);
      expect(rows[0].worker_raw_name).toBe('María González');
      expect(rows[0].origen).toBe('Talentum');
    });

    it('encuadre upsert is idempotent via dedup_hash', async () => {
      const dedupHash = 'e2e-sync-test-hash';

      // Insert again — should update, not create duplicate
      await pool.query(
        `INSERT INTO encuadres (worker_id, job_posting_id, worker_raw_name, worker_raw_phone, origen, dedup_hash)
         VALUES ($1, $2, $3, $4, 'Talentum', $5)
         ON CONFLICT (dedup_hash) DO UPDATE SET
           worker_id = COALESCE(encuadres.worker_id, EXCLUDED.worker_id), updated_at = NOW()`,
        [workerId, jobPostingId, 'María González Updated', '+5491100000000', dedupHash],
      );

      const { rows } = await pool.query(
        `SELECT COUNT(*)::int as cnt FROM encuadres WHERE dedup_hash = $1`,
        [dedupHash],
      );

      expect(rows[0].cnt).toBe(1); // no duplicate
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 6. DB-level: case_number lookup
  // ═══════════════════════════════════════════════════════════════════

  describe('Case number lookup — DB validation', () => {
    let jpId: string;

    beforeAll(async () => {
      const result = await pool.query(
        `INSERT INTO job_postings (case_number, title, description, country, status)
         VALUES ($1, $2, '', 'AR', 'SEARCHING')
         RETURNING id`,
        [99902, 'CASO 99902'],
      );
      jpId = result.rows[0].id;
    });

    afterAll(async () => {
      await pool.query('DELETE FROM job_postings WHERE id = $1', [jpId]).catch(() => {});
    });

    it('finds job_posting by case_number', async () => {
      const { rows } = await pool.query(
        `SELECT id FROM job_postings WHERE case_number = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
        [99902],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(jpId);
    });

    it('returns empty when case_number does not exist', async () => {
      const { rows } = await pool.query(
        `SELECT id FROM job_postings WHERE case_number = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
        [99999],
      );

      expect(rows).toHaveLength(0);
    });
  });
});
