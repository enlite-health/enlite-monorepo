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
 * The sync em si (Talentum v2 → DB, spec 040 F3) é provado na seção 7: o use case REAL roda neste
 * processo contra um stub HTTP da v2 (nada sai para a rede) e o Postgres de verdade. A lógica fina fica
 * nos unit tests de SyncTalentumWorkersUseCase.test.ts.
 */

import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';
import { TalentumV2Stub } from '../../src/modules/integration/infrastructure/__tests__/talentumV2Stub';

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

    it('creates encuadre with Talentum import_source_audit and dedup_hash', async () => {
      const dedupHash = 'e2e-sync-test-hash';

      // O trigger trg_ensure_encuadre_on_wja_insert já criou um encuadre ao inserir a WJA.
      // Usar ON CONFLICT (worker_id, job_posting_id) para atualizar o encuadre existente
      // com os dados do Talentum (import_source_audit, dedup_hash, worker_raw_name).
      await pool.query(
        `INSERT INTO encuadres (worker_id, job_posting_id, worker_raw_name, worker_raw_phone, import_source_audit, dedup_hash)
         VALUES ($1, $2, $3, $4, 'Talentum', $5)
         ON CONFLICT (worker_id, job_posting_id) DO UPDATE SET
           worker_raw_name     = EXCLUDED.worker_raw_name,
           worker_raw_phone    = EXCLUDED.worker_raw_phone,
           import_source_audit = EXCLUDED.import_source_audit,
           dedup_hash          = EXCLUDED.dedup_hash,
           updated_at          = NOW()`,
        [workerId, jobPostingId, 'María González', '+5491100000000', dedupHash],
      );

      const { rows } = await pool.query(
        `SELECT worker_id, job_posting_id, worker_raw_name, import_source_audit, dedup_hash
         FROM encuadres WHERE worker_id = $1 AND job_posting_id = $2`,
        [workerId, jobPostingId],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].worker_id).toBe(workerId);
      expect(rows[0].job_posting_id).toBe(jobPostingId);
      expect(rows[0].worker_raw_name).toBe('María González');
      expect(rows[0].import_source_audit).toBe('Talentum');
    });

    it('encuadre upsert is idempotent via (worker_id, job_posting_id)', async () => {
      const dedupHash = 'e2e-sync-test-hash';

      // Insert again — should update, not create duplicate.
      // Usa ON CONFLICT (worker_id, job_posting_id) pois a ADR-001 garante unique nesse par.
      await pool.query(
        `INSERT INTO encuadres (worker_id, job_posting_id, worker_raw_name, worker_raw_phone, import_source_audit, dedup_hash)
         VALUES ($1, $2, $3, $4, 'Talentum', $5)
         ON CONFLICT (worker_id, job_posting_id) DO UPDATE SET
           worker_raw_name = EXCLUDED.worker_raw_name,
           updated_at      = NOW()`,
        [workerId, jobPostingId, 'María González Updated', '+5491100000000', dedupHash],
      );

      const { rows } = await pool.query(
        `SELECT COUNT(*)::int as cnt FROM encuadres WHERE worker_id = $1 AND job_posting_id = $2`,
        [workerId, jobPostingId],
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

  // ═══════════════════════════════════════════════════════════════════
  // 7. Sync v2 (spec 040 F3): use case REAL + stub da Talentum v2 + Postgres de verdade
  // ═══════════════════════════════════════════════════════════════════

  describe('Sync v2 — candidatos do projeto viram candidatos da vaga certa (stub + Postgres)', () => {
    const STUB_PORT = Number(process.env.TALENTUM_STUB_PORT ?? 9914);
    const CASE_A = 99911;
    const CASE_B = 99912;
    const PHONE_REGISTERED = '5491155550001'; // worker JÁ cadastrado (REGISTERED), com e-mail
    const stub = new TalentumV2Stub();
    let closeStub: () => Promise<void>;
    let jpA: string;
    let jpB: string;
    let registeredId: string;
    let useCase: { execute: (o?: object) => Promise<any> };
    const envBackup = { ...process.env };

    const count = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0].n as number;

    beforeAll(async () => {
      closeStub = (await stub.serve(STUB_PORT)).close;
      process.env.DATABASE_URL = DATABASE_URL;
      process.env.TALENTUM_API_BASE_URL = `http://localhost:${STUB_PORT}`;
      process.env.TALENTUM_API_EMAIL = 'stub-user-e2e-only';
      process.env.TALENTUM_API_PASSWORD = 'stub-key-e2e-only';

      jpA = (await pool.query(
        `INSERT INTO job_postings (case_number, title, description, country, status, talentum_project_id)
         VALUES ($1, 'EN 99911#1', '', 'AR', 'SEARCHING', 'e2e-v2-proj-A') RETURNING id`, [CASE_A],
      )).rows[0].id;
      jpB = (await pool.query(
        `INSERT INTO job_postings (case_number, title, description, country, status, talentum_project_id)
         VALUES ($1, 'EN 99912#1', '', 'AR', 'SEARCHING', 'e2e-v2-proj-B') RETURNING id`, [CASE_B],
      )).rows[0].id;
      registeredId = (await pool.query(
        `INSERT INTO workers (auth_uid, email, phone, status, country)
         VALUES ('e2e-v2-firebase-uid', 'e2e-v2-registered@test.com', $1, 'REGISTERED', 'AR') RETURNING id`, [PHONE_REGISTERED],
      )).rows[0].id;

      // A: 1 cadastrado (telefone no formato de 10 dígitos que a v2 devolve) + 2 NOVOS só com telefone, sem e-mail.
      stub.seed({
        _id: 'e2e-v2-proj-A', name: 'EN 99911#1', status: 'IN_PROGRESS',
        candidates: [
          { profileId: 'e2e-v2-pf-registered', firstName: 'Registrada', lastName: 'Sintetica', phoneNumber: '1155550001' },
          { profileId: 'e2e-v2-pf-new-1', firstName: 'Nova', lastName: 'Um', phoneNumber: '1155550002' },
          { profileId: 'e2e-v2-pf-new-2', firstName: 'Nova', lastName: 'Dois', phoneNumber: '1155550003' },
        ],
      });
      // B: o MESMO cadastrado também está no projeto B (vaga B)
      stub.seed({
        _id: 'e2e-v2-proj-B', name: 'EN 99912#1', status: 'IN_PROGRESS',
        candidates: [{ profileId: 'e2e-v2-pf-registered', firstName: 'Registrada', lastName: 'Sintetica', phoneNumber: '1155550001' }],
      });
      // C: projeto IN_PROGRESS SEM vaga nossa: ninguém dele pode virar worker
      stub.seed({
        _id: 'e2e-v2-proj-orfao', name: 'EN 99913#1', status: 'IN_PROGRESS',
        candidates: [{ profileId: 'e2e-v2-pf-orfao', firstName: 'Orfa', lastName: 'Sem Vaga', phoneNumber: '1155550009' }],
      });

      const { SyncTalentumWorkersUseCase } = require('@modules/integration');
      useCase = new SyncTalentumWorkersUseCase();
    });

    afterAll(async () => {
      const ids = (await pool.query(`SELECT id FROM workers WHERE auth_uid LIKE 'talentum_e2e-v2-%' OR id = $1`, [registeredId])).rows.map((r) => r.id);
      await pool.query('DELETE FROM encuadres WHERE worker_id = ANY($1)', [ids]).catch(() => {});
      await pool.query('DELETE FROM worker_job_applications WHERE worker_id = ANY($1)', [ids]).catch(() => {});
      await pool.query('DELETE FROM workers WHERE id = ANY($1)', [ids]).catch(() => {});
      await pool.query('DELETE FROM job_postings WHERE id = ANY($1)', [[jpA, jpB]]).catch(() => {});
      const { DatabaseConnection } = require('@shared/database/DatabaseConnection');
      await DatabaseConnection.getInstance().close();
      process.env = { ...envBackup };
      if (closeStub) await closeStub();
    });

    it('schema (migration 499): workers.email é anulável e o UNIQUE continua valendo', async () => {
      const col = await pool.query(
        `SELECT is_nullable FROM information_schema.columns WHERE table_name = 'workers' AND column_name = 'email'`,
      );
      expect(col.rows[0].is_nullable).toBe('YES');

      const ids: string[] = [];
      try {
        // vários NULL coexistem no UNIQUE...
        for (const uid of ['e2e-v2-null-1', 'e2e-v2-null-2']) {
          ids.push((await pool.query(`INSERT INTO workers (auth_uid, email, status, country) VALUES ($1, NULL, 'INCOMPLETE_REGISTER', 'AR') RETURNING id`, [uid])).rows[0].id);
        }
        expect(ids).toHaveLength(2);
        // ...e e-mail repetido continua colidindo
        await expect(
          pool.query(`INSERT INTO workers (auth_uid, email, status, country) VALUES ('e2e-v2-dup', 'e2e-v2-registered@test.com', 'INCOMPLETE_REGISTER', 'AR')`),
        ).rejects.toMatchObject({ code: '23505' });
      } finally {
        await pool.query('DELETE FROM workers WHERE id = ANY($1)', [ids]);
      }
    });

    it('1ª execução: cadastrado vira candidato da vaga CERTA em cada projeto; novos nascem só com telefone (e-mail NULL); projeto sem vaga é ignorado', async () => {
      const report = await useCase.execute();

      expect(report).toMatchObject({ projects: 2, projectsWithoutVacancy: 1, errors: [], conflicts: [] });
      // worker cadastrado → WJA INVITED na vaga A E na vaga B (uma por projeto)
      const wja = (await pool.query(
        `SELECT job_posting_id, application_funnel_stage, source FROM worker_job_applications WHERE worker_id = $1 ORDER BY job_posting_id`, [registeredId],
      )).rows;
      expect(wja.map((r) => r.job_posting_id).sort()).toEqual([jpA, jpB].sort());
      expect(wja.every((r) => r.application_funnel_stage === 'INVITED' && r.source === 'talentum')).toBe(true);
      expect(await count(`SELECT COUNT(*)::int AS n FROM workers WHERE phone = $1`, [PHONE_REGISTERED])).toBe(1); // sem duplicata
      // novos: só telefone normalizado, e-mail NULL, INCOMPLETE_REGISTER
      const created = (await pool.query(
        `SELECT auth_uid, email, phone, status FROM workers WHERE auth_uid LIKE 'talentum_e2e-v2-pf-new-%' ORDER BY auth_uid`,
      )).rows;
      expect(created).toEqual([
        { auth_uid: 'talentum_e2e-v2-pf-new-1', email: null, phone: '5491155550002', status: 'INCOMPLETE_REGISTER' },
        { auth_uid: 'talentum_e2e-v2-pf-new-2', email: null, phone: '5491155550003', status: 'INCOMPLETE_REGISTER' },
      ]);
      // o projeto sem vaga nunca gerou worker
      expect(await count(`SELECT COUNT(*)::int AS n FROM workers WHERE auth_uid = 'talentum_e2e-v2-pf-orfao' OR phone = '5491155550009'`)).toBe(0);
      expect(stub.calls.every((c) => c.method === 'GET' || c.path === '/auth/login')).toBe(true); // 0 escritas na Talentum
      expect(stub.calls.some((c) => c.path.includes('e2e-v2-proj-orfao'))).toBe(false);          // nem foi lido
    });

    it('2ª execução é IDEMPOTENTE: nada novo em workers, WJA nem encuadres', async () => {
      const before = {
        workers: await count(`SELECT COUNT(*)::int AS n FROM workers`),
        wja: await count(`SELECT COUNT(*)::int AS n FROM worker_job_applications WHERE worker_id = $1`, [registeredId]),
        enc: await count(`SELECT COUNT(*)::int AS n FROM encuadres WHERE worker_id = $1`, [registeredId]),
      };

      const report = await useCase.execute();

      expect(report).toMatchObject({ created: 0, linked: 0, errors: [] });
      expect(await count(`SELECT COUNT(*)::int AS n FROM workers`)).toBe(before.workers);
      expect(await count(`SELECT COUNT(*)::int AS n FROM worker_job_applications WHERE worker_id = $1`, [registeredId])).toBe(before.wja);
      expect(await count(`SELECT COUNT(*)::int AS n FROM encuadres WHERE worker_id = $1`, [registeredId])).toBe(before.enc);
      expect(before.wja).toBe(2);
      expect(before.enc).toBe(2);
    });
  });
});
