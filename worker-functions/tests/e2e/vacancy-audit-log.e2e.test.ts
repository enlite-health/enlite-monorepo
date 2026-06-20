/**
 * vacancy-audit-log.e2e.test.ts  — Onda B
 *
 * Verifica que TODA mutação de job_postings grava uma linha em
 * job_posting_audit_log com o ator correto.
 *
 * Cobertura mínima obrigatória:
 *   1. POST   /api/admin/vacancies              → CREATED, actor_type=HUMAN, actor_user_id != null
 *   2. PUT    /api/admin/vacancies/:id          → STATUS_CHANGED e UPDATED com before/after corretos
 *   3. DELETE /api/admin/vacancies/:id          → DELETED, before != null
 *   4. publish-talentum (failure path)          → nenhuma linha escrita na falha (atomicidade)
 *   5. POST   /api/webhooks/talentum/prescreening → CREATED com actor_type=WEBHOOK, actor_user_id=NULL
 */

import { Pool } from 'pg';
import { createApiClient, createPatientFixture, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getAuditRows(
  pool: Pool,
  jobPostingId: string,
): Promise<Array<{
  event_type: string;
  field_name: string | null;
  changes: { before: unknown; after: unknown };
  actor_user_id: string | null;
  actor_type: string;
  actor_label: string | null;
}>> {
  const res = await pool.query(
    `SELECT event_type, field_name, changes, actor_user_id, actor_type, actor_label
     FROM job_posting_audit_log
     WHERE job_posting_id = $1
     ORDER BY created_at ASC`,
    [jobPostingId],
  );
  return res.rows;
}

async function cleanupVacancy(pool: Pool, id: string): Promise<void> {
  await pool.query(`DELETE FROM job_posting_audit_log WHERE job_posting_id = $1`, [id]).catch(() => {});
  await pool.query(`DELETE FROM job_postings WHERE id = $1`, [id]).catch(() => {});
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('Vacancy Audit Log — Onda B', () => {
  const api = createApiClient();
  let adminToken: string;
  let pool: Pool;
  let patientId: string;
  const createdVacancyIds: string[] = [];

  // UID must exist in users table because of the FK constraint on actor_user_id
  const ADMIN_UID = 'audit-e2e-admin-001';

  function auth() {
    return { headers: { Authorization: `Bearer ${adminToken}` } };
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await waitForBackend(api);

    // Seed the user so actor_user_id FK passes
    await pool.query(
      `INSERT INTO users (firebase_uid, email, display_name, role)
       VALUES ($1, $2, $3, 'admin')
       ON CONFLICT (firebase_uid) DO NOTHING`,
      [ADMIN_UID, 'audit-e2e-admin@e2e.local', 'Audit E2E Admin'],
    );

    adminToken = await getMockToken(api, {
      uid: ADMIN_UID,
      email: 'audit-e2e-admin@e2e.local',
      role: 'admin',
    });

    patientId = await createPatientFixture(pool, 'audit-log');
  });

  afterAll(async () => {
    for (const id of createdVacancyIds) {
      await cleanupVacancy(pool, id);
    }
    await pool.query(`DELETE FROM patients WHERE id = $1`, [patientId]).catch(() => {});
    await pool.query(`DELETE FROM users WHERE firebase_uid = $1`, [ADMIN_UID]).catch(() => {});
    await pool.end();
  });

  // ── 1. CREATE → CREATED audit ─────────────────────────────────────────────

  describe('1. POST /api/admin/vacancies → CREATED audit', () => {
    let vacancyId: string;

    beforeAll(async () => {
      const res = await api.post(
        '/api/admin/vacancies',
        { patient_id: patientId, case_number: 88801, status: 'SEARCHING' },
        auth(),
      );
      expect(res.status).toBe(201);
      vacancyId = res.data.data.id as string;
      createdVacancyIds.push(vacancyId);
    });

    it('inserts exactly 1 CREATED audit row', async () => {
      const rows = await getAuditRows(pool, vacancyId);
      const created = rows.filter(r => r.event_type === 'CREATED');
      expect(created).toHaveLength(1);
    });

    it('CREATED row has actor_type=HUMAN and actor_user_id=ADMIN_UID', async () => {
      const rows = await getAuditRows(pool, vacancyId);
      const row = rows.find(r => r.event_type === 'CREATED')!;
      expect(row.actor_type).toBe('HUMAN');
      expect(row.actor_user_id).toBe(ADMIN_UID);
      expect(row.actor_label).toBe('admin_panel');
    });

    it('CREATED row has before=null and after contains vacancy id', async () => {
      const rows = await getAuditRows(pool, vacancyId);
      const row = rows.find(r => r.event_type === 'CREATED')!;
      expect(row.changes.before).toBeNull();
      expect(row.changes.after).toBeTruthy();
      expect((row.changes.after as Record<string, unknown>).id).toBe(vacancyId);
    });
  });

  // ── 2. UPDATE → STATUS_CHANGED / UPDATED audit ───────────────────────────

  describe('2. PUT /api/admin/vacancies/:id → field-level audit', () => {
    let vacancyId: string;

    beforeAll(async () => {
      const res = await api.post(
        '/api/admin/vacancies',
        { patient_id: patientId, case_number: 88802, status: 'PENDING_ACTIVATION' },
        auth(),
      );
      expect(res.status).toBe(201);
      vacancyId = res.data.data.id as string;
      createdVacancyIds.push(vacancyId);
    });

    it('PUT with status change produces STATUS_CHANGED row with before/after', async () => {
      const res = await api.put(
        `/api/admin/vacancies/${vacancyId}`,
        { status: 'SEARCHING' },
        auth(),
      );
      expect(res.status).toBe(200);

      const rows = await getAuditRows(pool, vacancyId);
      const statusRow = rows.find(r => r.event_type === 'STATUS_CHANGED');
      expect(statusRow).toBeDefined();
      expect(statusRow!.field_name).toBe('status');
      expect(statusRow!.changes.before).toBe('PENDING_ACTIVATION');
      expect(statusRow!.changes.after).toBe('SEARCHING');
      expect(statusRow!.actor_type).toBe('HUMAN');
      expect(statusRow!.actor_user_id).toBe(ADMIN_UID);
    });

    it('PUT with non-status field produces UPDATED row', async () => {
      // salary_text is in FULL_ALLOWED_UPDATE_FIELDS; vacancy is_draft=true by default
      const res = await api.put(
        `/api/admin/vacancies/${vacancyId}`,
        { salary_text: 'ARS 1500/hora' },
        auth(),
      );
      expect(res.status).toBe(200);

      const rows = await getAuditRows(pool, vacancyId);
      const updatedRow = rows.find(r => r.event_type === 'UPDATED' && r.field_name === 'salary_text');
      expect(updatedRow).toBeDefined();
      expect(updatedRow!.changes.after).toBe('ARS 1500/hora');
    });
  });

  // ── 3. DELETE → DELETED audit ─────────────────────────────────────────────

  describe('3. DELETE /api/admin/vacancies/:id → DELETED audit', () => {
    let vacancyId: string;

    beforeAll(async () => {
      const res = await api.post(
        '/api/admin/vacancies',
        { patient_id: patientId, case_number: 88803, status: 'PENDING_ACTIVATION' },
        auth(),
      );
      expect(res.status).toBe(201);
      vacancyId = res.data.data.id as string;
    });

    it('soft-delete returns 200', async () => {
      const res = await api.delete(`/api/admin/vacancies/${vacancyId}`, auth());
      expect(res.status).toBe(200);
    });

    it('inserts a DELETED audit row with before snapshot', async () => {
      const rows = await getAuditRows(pool, vacancyId);
      const deleted = rows.find(r => r.event_type === 'DELETED');
      expect(deleted).toBeDefined();
      expect(deleted!.changes.before).toBeTruthy();
      expect(deleted!.changes.after).toBeNull();
      expect(deleted!.actor_type).toBe('HUMAN');
      expect(deleted!.actor_user_id).toBe(ADMIN_UID);
    });

    afterAll(async () => {
      await cleanupVacancy(pool, vacancyId);
    });
  });

  // ── 4. Publish failure → no audit row written ────────────────────────────

  describe('4. publish-talentum failure → no DRAFT_CHANGED row written', () => {
    let vacancyId: string;

    beforeAll(async () => {
      const res = await api.post(
        '/api/admin/vacancies',
        { patient_id: patientId, case_number: 88804, status: 'SEARCHING' },
        auth(),
      );
      expect(res.status).toBe(201);
      vacancyId = res.data.data.id as string;
      createdVacancyIds.push(vacancyId);
    });

    it('publish without prescreening returns 400 (no prescreening questions)', async () => {
      const res = await api.post(
        `/api/admin/vacancies/${vacancyId}/publish-talentum`,
        {},
        auth(),
      );
      // 400 = no prescreening questions; 502 = Talentum API not reachable in E2E
      expect([400, 502]).toContain(res.status);
    });

    it('no DRAFT_CHANGED row written on publish failure (atomicity)', async () => {
      const rows = await getAuditRows(pool, vacancyId);
      const draftChanged = rows.filter(r => r.event_type === 'DRAFT_CHANGED');
      expect(draftChanged).toHaveLength(0);
    });
  });

  // ── 5. Talentum webhook → CREATED with actor_type=WEBHOOK ────────────────

  describe('5. POST /api/webhooks/talentum/prescreening → WEBHOOK CREATED', () => {
    let createdJobPostingId: string | undefined;
    const talentumProjectId = `e2e-audit-test-${Date.now()}`;

    beforeAll(async () => {
      // In E2E, USE_MOCK_AUTH=true bypasses Google token verification.
      // Talentum PRESCREENING.CREATED payload format from talentumPrescreeningSchema.ts
      const res = await api.post('/api/webhooks/talentum/prescreening', {
        action: 'PRESCREENING',
        subtype: 'CREATED',
        data: {
          _id: talentumProjectId,
          name: `CASO 88805-${Math.floor(Math.random() * 9000 + 1000)}`,
        },
      });
      // 200 = handled (created, linked, or skipped)
      expect(res.status).toBe(200);
      createdJobPostingId = (res.data as Record<string, unknown>).jobPostingId as string | undefined;
    });

    it('returns jobPostingId in the response', () => {
      expect(createdJobPostingId).toBeTruthy();
      if (createdJobPostingId) createdVacancyIds.push(createdJobPostingId);
    });

    it('has a CREATED audit row with actor_type=WEBHOOK and actor_user_id=NULL', async () => {
      if (!createdJobPostingId) return; // skip if skipped path
      const rows = await getAuditRows(pool, createdJobPostingId);
      const created = rows.find(r => r.event_type === 'CREATED');
      expect(created).toBeDefined();
      expect(created!.actor_type).toBe('WEBHOOK');
      expect(created!.actor_user_id).toBeNull();
      expect(created!.actor_label).toBe('talentum_webhook');
    });
  });
});
