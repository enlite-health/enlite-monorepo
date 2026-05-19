/**
 * in-progress-vacancies.e2e.test.ts
 *
 * Integration tests for GET /api/admin/vacancies/in-progress?patient_id=:uuid
 *
 * Scenarios:
 *   1. Patient with 1 app-only draft (is_draft = true) → returns it
 *   2. Draft (is_draft = true) with row in job_postings_clickup_sync → filtered out
 *   3. Published vacancy (is_draft = false, any status) → filtered out
 *   4. Patient with no vacancies → empty array
 *   5. Malformed patient_id → 400
 *   6. Missing patient_id → 400
 *   7. Deleted vacancy (deleted_at IS NOT NULL) → filtered out
 *   8. Response shape: id, case_number, vacancy_number, title, created_at, updated_at
 *   9. Without auth → 401
 *  10. Worker role → 403
 */

import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const PREFIX = 'ip-e2e';

// Deterministic UUIDs
const IDS = {
  patient:        `ee220001-0000-0000-0001-000000000001`,
  patientEmpty:   `ee220001-0000-0000-0001-000000000002`,
  // vacancies
  appDraft:       `ee220001-0000-0000-0002-000000000001`,
  clickupDraft:   `ee220001-0000-0000-0002-000000000002`,
  searchingVac:   `ee220001-0000-0000-0002-000000000003`,
  deletedDraft:   `ee220001-0000-0000-0002-000000000004`,
};

const api = createApiClient();
let pool: Pool;
let adminToken: string;
let workerToken: string;

// Vacancy number counter to avoid unique constraint violations
let vacCounter = 8000;
function nextVac() { return ++vacCounter; }

async function cleanup(p: Pool): Promise<void> {
  const jobIds = Object.values(IDS).filter(id => id.startsWith('ee220001-0000-0000-0002-'));
  const patientIds = Object.values(IDS).filter(id => id.startsWith('ee220001-0000-0000-0001-'));

  await p.query(
    `DELETE FROM job_postings_clickup_sync WHERE job_posting_id = ANY($1)`,
    [jobIds],
  ).catch(() => {});
  await p.query(`DELETE FROM job_postings WHERE id = ANY($1)`, [jobIds]).catch(() => {});
  await p.query(`DELETE FROM patients WHERE id = ANY($1)`, [patientIds]).catch(() => {});
}

async function insertPatient(p: Pool, id: string): Promise<void> {
  await p.query(
    `INSERT INTO patients (id, clickup_task_id, service_type, dependency_level, status)
     VALUES ($1, $2, ARRAY['AT']::text[], 'MODERATE', 'ACTIVE')
     ON CONFLICT (id) DO NOTHING`,
    [id, `${PREFIX}-task-${id.slice(-4)}`],
  );
}

async function insertVacancy(
  p: Pool,
  id: string,
  patientId: string,
  status: string,
  vacancyNumber: number,
  caseNumber: number,
  deletedAt?: string,
  // Migration 168 default is `true`. Tests that seed "already published"
  // vacancies (e.g. the SEARCHING fixture used to assert it does NOT appear
  // in /in-progress) must pass `false` explicitly — otherwise the new
  // is_draft = true filter would make them surface as drafts.
  isDraft = true,
): Promise<void> {
  await p.query(
    `INSERT INTO job_postings
       (id, case_number, vacancy_number, title, status, description, patient_id, deleted_at, is_draft)
     VALUES ($1, $2, $3, $4, $5, 'E2E draft', $6, $7::timestamptz, $8)
     ON CONFLICT (id) DO NOTHING`,
    [
      id,
      caseNumber,
      vacancyNumber,
      `CASO ${caseNumber}-${vacancyNumber}`,
      status,
      patientId,
      deletedAt ?? null,
      isDraft,
    ],
  );
}

function authHeaders(token: string) {
  return { headers: { Authorization: `Bearer ${token}` } };
}

describe('GET /api/admin/vacancies/in-progress', () => {
  beforeAll(async () => {
    await waitForBackend(api);
    pool = new Pool({ connectionString: DATABASE_URL });

    [adminToken, workerToken] = await Promise.all([
      getMockToken(api, { uid: 'ip-admin-e2e', email: 'ip-admin@e2e.local', role: 'admin' }),
      getMockToken(api, { uid: 'ip-worker-e2e', email: 'ip-worker@e2e.local', role: 'worker' }),
    ]);

    await cleanup(pool);

    // Patients
    await insertPatient(pool, IDS.patient);
    await insertPatient(pool, IDS.patientEmpty);

    // 1. App-only PENDING_ACTIVATION draft (no clickup_sync row)
    await insertVacancy(pool, IDS.appDraft, IDS.patient, 'PENDING_ACTIVATION', nextVac(), 8801);

    // 2. ClickUp-synced PENDING_ACTIVATION draft (has clickup_sync row → must be excluded)
    await insertVacancy(pool, IDS.clickupDraft, IDS.patient, 'PENDING_ACTIVATION', nextVac(), 8802);
    await pool.query(
      `INSERT INTO job_postings_clickup_sync (job_posting_id, clickup_task_id)
       VALUES ($1, '${PREFIX}-clickup-task-001')
       ON CONFLICT DO NOTHING`,
      [IDS.clickupDraft],
    );

    // 3. SEARCHING vacancy already published (is_draft = false) → must be excluded.
    // With the migration 168 contract, the filter is is_draft = true (not the old
    // status = PENDING_ACTIVATION proxy), so a SEARCHING vacancy with is_draft =
    // true would actually appear in /in-progress (regression case 771-718).
    // Here we want to assert the post-publish state — already non-draft.
    await insertVacancy(pool, IDS.searchingVac, IDS.patient, 'SEARCHING', nextVac(), 8803, undefined, false);

    // 4. Soft-deleted PENDING_ACTIVATION draft (deleted_at IS NOT NULL → excluded)
    await insertVacancy(pool, IDS.deletedDraft, IDS.patient, 'PENDING_ACTIVATION', nextVac(), 8804, '2026-01-01T00:00:00.000Z');
  });

  afterAll(async () => {
    await cleanup(pool);
    await pool.end();
  });

  // ── scenario 1: app-only draft returned ───────────────────────────────────

  it('returns app-only PENDING_ACTIVATION draft', async () => {
    const res = await api.get(
      `/api/admin/vacancies/in-progress?patient_id=${IDS.patient}`,
      authHeaders(adminToken),
    );
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    const ids = (res.data.data as Array<{ id: string }>).map(d => d.id);
    expect(ids).toContain(IDS.appDraft);
  });

  // ── scenario 2: clickup-synced draft filtered out ─────────────────────────

  it('does NOT return ClickUp-synced PENDING_ACTIVATION draft', async () => {
    const res = await api.get(
      `/api/admin/vacancies/in-progress?patient_id=${IDS.patient}`,
      authHeaders(adminToken),
    );
    expect(res.status).toBe(200);
    const ids = (res.data.data as Array<{ id: string }>).map(d => d.id);
    expect(ids).not.toContain(IDS.clickupDraft);
  });

  // ── scenario 3: wrong status filtered out ────────────────────────────────

  it('does NOT return published vacancy (is_draft = false), even if status is SEARCHING', async () => {
    const res = await api.get(
      `/api/admin/vacancies/in-progress?patient_id=${IDS.patient}`,
      authHeaders(adminToken),
    );
    const ids = (res.data.data as Array<{ id: string }>).map(d => d.id);
    expect(ids).not.toContain(IDS.searchingVac);
  });

  // ── scenario 4: patient with no vacancies → empty array ──────────────────

  it('returns empty array for patient with no vacancies', async () => {
    const res = await api.get(
      `/api/admin/vacancies/in-progress?patient_id=${IDS.patientEmpty}`,
      authHeaders(adminToken),
    );
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.data).toEqual([]);
  });

  // ── scenario 5: malformed patient_id → 400 ───────────────────────────────

  it('returns 400 for malformed patient_id', async () => {
    const res = await api.get(
      `/api/admin/vacancies/in-progress?patient_id=not-a-uuid`,
      authHeaders(adminToken),
    );
    expect(res.status).toBe(400);
    expect(res.data.success).toBe(false);
  });

  // ── scenario 6: missing patient_id → 400 ─────────────────────────────────

  it('returns 400 when patient_id is missing', async () => {
    const res = await api.get(
      `/api/admin/vacancies/in-progress`,
      authHeaders(adminToken),
    );
    expect(res.status).toBe(400);
    expect(res.data.success).toBe(false);
  });

  // ── scenario 7: deleted draft filtered out ───────────────────────────────

  it('does NOT return soft-deleted PENDING_ACTIVATION draft', async () => {
    const res = await api.get(
      `/api/admin/vacancies/in-progress?patient_id=${IDS.patient}`,
      authHeaders(adminToken),
    );
    const ids = (res.data.data as Array<{ id: string }>).map(d => d.id);
    expect(ids).not.toContain(IDS.deletedDraft);
  });

  // ── scenario 8: response shape ────────────────────────────────────────────

  it('response items contain id, case_number, vacancy_number, title, created_at, updated_at', async () => {
    const res = await api.get(
      `/api/admin/vacancies/in-progress?patient_id=${IDS.patient}`,
      authHeaders(adminToken),
    );
    expect(res.status).toBe(200);
    const data = res.data.data as Array<Record<string, unknown>>;
    expect(data.length).toBeGreaterThan(0);
    const item = data[0];
    expect(item).toHaveProperty('id');
    expect(item).toHaveProperty('case_number');
    expect(item).toHaveProperty('vacancy_number');
    expect(item).toHaveProperty('title');
    expect(item).toHaveProperty('created_at');
    expect(item).toHaveProperty('updated_at');
  });

  // ── scenario 9: no auth → 401 ────────────────────────────────────────────

  it('returns 401 without auth token', async () => {
    const res = await api.get(
      `/api/admin/vacancies/in-progress?patient_id=${IDS.patient}`,
    );
    expect(res.status).toBe(401);
  });

  // ── scenario 10: worker role → 403 ───────────────────────────────────────

  it('returns 403 for worker role', async () => {
    const res = await api.get(
      `/api/admin/vacancies/in-progress?patient_id=${IDS.patient}`,
      authHeaders(workerToken),
    );
    expect(res.status).toBe(403);
  });
});
