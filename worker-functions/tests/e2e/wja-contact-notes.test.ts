/**
 * wja-contact-notes.test.ts
 *
 * E2E tests for WJA Contact Notes feature:
 *   POST /api/admin/vacancies/:vacancyId/applications/:wjaId/contact-notes
 *   GET  /api/admin/vacancies/:vacancyId/applications/:wjaId/contact-notes
 *
 * Also validates Feature A (registrationComplete + contactNotesCount) via:
 *   GET /api/admin/vacancies/:id/funnel-table
 */

import { Pool } from 'pg';
import { createApiClient, createPatientFixture, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

// ── Deterministic IDs ─────────────────────────────────────────────────────────

const IDS = {
  patient: 'c0000001-0000-4000-a001-000000000001',
  vacancy: 'c0000001-0000-4000-a002-000000000001',
  otherVacancy: 'c0000001-0000-4000-a002-000000000002',
  worker: 'c0000001-0000-4000-a003-000000000001',
  wja: 'c0000001-0000-4000-a004-000000000001',
  otherWja: 'c0000001-0000-4000-a004-000000000002',
};

describe('WJA Contact Notes', () => {
  const api = createApiClient();
  let adminToken: string;
  let pool: Pool;

  beforeAll(async () => {
    await waitForBackend(api);

    adminToken = await getMockToken(api, {
      uid: 'cn-admin-e2e',
      email: 'cn-admin@e2e.local',
      role: 'admin',
    });

    pool = new Pool({ connectionString: DATABASE_URL });
    await seedFixtures(pool);
  });

  afterAll(async () => {
    await cleanFixtures(pool);
    await pool.end();
  });

  function auth() {
    return { headers: { Authorization: `Bearer ${adminToken}` } };
  }

  // ── POST creates note ─────────────────────────────────────────────────────

  describe('POST /:vacancyId/applications/:wjaId/contact-notes', () => {
    it('creates a note and returns 201 with noteText, createdByAdminId, createdAt', async () => {
      const res = await api.post(
        `/api/admin/vacancies/${IDS.vacancy}/applications/${IDS.wja}/contact-notes`,
        { noteText: 'Primeiro contato realizado via WhatsApp' },
        auth(),
      );

      expect(res.status).toBe(201);
      expect(res.data.success).toBe(true);
      expect(res.data.data.noteText).toBe('Primeiro contato realizado via WhatsApp');
      expect(res.data.data.createdByAdminId).toBe('cn-admin-e2e');
      expect(typeof res.data.data.createdAt).toBe('string');
      expect(res.data.data.id).toBeTruthy();
    });

    it('returns 400 when noteText exceeds 240 characters', async () => {
      const longText = 'a'.repeat(241);
      const res = await api.post(
        `/api/admin/vacancies/${IDS.vacancy}/applications/${IDS.wja}/contact-notes`,
        { noteText: longText },
        auth(),
      );

      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
    });

    it('returns 400 when noteText is empty string', async () => {
      const res = await api.post(
        `/api/admin/vacancies/${IDS.vacancy}/applications/${IDS.wja}/contact-notes`,
        { noteText: '' },
        auth(),
      );

      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
    });

    it('returns 400 when noteText is only whitespace', async () => {
      const res = await api.post(
        `/api/admin/vacancies/${IDS.vacancy}/applications/${IDS.wja}/contact-notes`,
        { noteText: '   ' },
        auth(),
      );

      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
    });

    it('returns 404 when wjaId belongs to a different vacancy', async () => {
      // IDS.otherWja belongs to IDS.otherVacancy, not IDS.vacancy
      const res = await api.post(
        `/api/admin/vacancies/${IDS.vacancy}/applications/${IDS.otherWja}/contact-notes`,
        { noteText: 'Nota válida mas WJA errada' },
        auth(),
      );

      expect(res.status).toBe(404);
      expect(res.data.success).toBe(false);
    });
  });

  // ── GET lists notes in DESC order ────────────────────────────────────────

  describe('GET /:vacancyId/applications/:wjaId/contact-notes', () => {
    beforeAll(async () => {
      // Insert two notes with known timestamps (older first, then newer)
      await pool.query(
        `INSERT INTO wja_contact_notes
           (worker_job_application_id, note_text, created_by_admin_id, created_by_admin_email, created_at)
         VALUES ($1, 'Nota mais antiga', 'cn-admin-e2e', 'cn-admin@e2e.local', NOW() - INTERVAL '10 minutes')`,
        [IDS.wja],
      );
      await pool.query(
        `INSERT INTO wja_contact_notes
           (worker_job_application_id, note_text, created_by_admin_id, created_by_admin_email, created_at)
         VALUES ($1, 'Nota mais recente', 'cn-admin-e2e', 'cn-admin@e2e.local', NOW())`,
        [IDS.wja],
      );
    });

    it('returns notes in DESC order (most recent first)', async () => {
      const res = await api.get(
        `/api/admin/vacancies/${IDS.vacancy}/applications/${IDS.wja}/contact-notes`,
        auth(),
      );

      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      const notes = res.data.data as Array<{ noteText: string; createdAt: string }>;
      expect(notes.length).toBeGreaterThanOrEqual(2);

      // The most recent note must be first
      const notaRecente = notes.find(n => n.noteText === 'Nota mais recente');
      const notaAntiga = notes.find(n => n.noteText === 'Nota mais antiga');
      expect(notaRecente).toBeDefined();
      expect(notaAntiga).toBeDefined();

      const idxRecente = notes.indexOf(notaRecente!);
      const idxAntiga = notes.indexOf(notaAntiga!);
      expect(idxRecente).toBeLessThan(idxAntiga);
    });

    it('returns 404 when wjaId belongs to a different vacancy', async () => {
      const res = await api.get(
        `/api/admin/vacancies/${IDS.vacancy}/applications/${IDS.otherWja}/contact-notes`,
        auth(),
      );

      expect(res.status).toBe(404);
      expect(res.data.success).toBe(false);
    });
  });

  // ── Feature A: registrationComplete + contactNotesCount in funnel-table ──

  describe('GET /vacancies/:id/funnel-table — Feature A fields', () => {
    it('returns registrationComplete=true for REGISTERED worker', async () => {
      const res = await api.get(
        `/api/admin/vacancies/${IDS.vacancy}/funnel-table`,
        auth(),
      );

      expect(res.status).toBe(200);
      const rows = res.data.data.rows as Array<{
        workerId: string;
        registrationComplete: boolean;
        contactNotesCount: number;
      }>;

      const row = rows.find(r => r.workerId === IDS.worker);
      expect(row).toBeDefined();
      expect(row!.registrationComplete).toBe(true);
    });

    it('returns contactNotesCount matching actual notes for the WJA', async () => {
      // Count notes in DB directly for comparison
      const dbResult = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM wja_contact_notes WHERE worker_job_application_id = $1`,
        [IDS.wja],
      );
      const expectedCount = parseInt(dbResult.rows[0].count, 10);

      const res = await api.get(
        `/api/admin/vacancies/${IDS.vacancy}/funnel-table`,
        auth(),
      );

      expect(res.status).toBe(200);
      const rows = res.data.data.rows as Array<{
        workerId: string;
        contactNotesCount: number;
      }>;

      const row = rows.find(r => r.workerId === IDS.worker);
      expect(row).toBeDefined();
      expect(row!.contactNotesCount).toBe(expectedCount);
    });
  });
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

async function seedFixtures(pool: Pool): Promise<void> {
  await cleanFixtures(pool);

  // Patient
  await pool.query(
    `INSERT INTO patients (id, clickup_task_id, country, first_name, last_name)
     VALUES ($1, 'cn-e2e-task-001', 'AR', 'CnTest', 'Patient')
     ON CONFLICT (id) DO NOTHING`,
    [IDS.patient],
  );

  // Vacancy numbers
  const vnRes = await pool.query<{ vn: string }>(
    "SELECT nextval('job_postings_vacancy_number_seq') AS vn",
  );
  const vn1 = parseInt(vnRes.rows[0].vn);
  const vnRes2 = await pool.query<{ vn: string }>(
    "SELECT nextval('job_postings_vacancy_number_seq') AS vn",
  );
  const vn2 = parseInt(vnRes2.rows[0].vn);

  // Main vacancy
  await pool.query(
    `INSERT INTO job_postings (id, vacancy_number, case_number, patient_id, title, description, country, status)
     VALUES ($1, $2, 99101, $3, 'cn-e2e-vacancy', '', 'AR', 'SEARCHING')
     ON CONFLICT (id) DO NOTHING`,
    [IDS.vacancy, vn1, IDS.patient],
  );

  // Other vacancy (used for cross-vacancy isolation test)
  await pool.query(
    `INSERT INTO job_postings (id, vacancy_number, case_number, patient_id, title, description, country, status)
     VALUES ($1, $2, 99102, $3, 'cn-e2e-other-vacancy', '', 'AR', 'SEARCHING')
     ON CONFLICT (id) DO NOTHING`,
    [IDS.otherVacancy, vn2, IDS.patient],
  );

  // Worker with status=REGISTERED (required: migration 183 blocks WJA for non-REGISTERED workers)
  await pool.query(
    `INSERT INTO workers (id, auth_uid, email, phone, status, country)
     VALUES ($1, 'cn-worker-uid', 'cn-worker@e2e.local', '+54911000099', 'REGISTERED', 'AR')
     ON CONFLICT (id) DO NOTHING`,
    [IDS.worker],
  );

  // WJA for main vacancy
  await pool.query(
    `INSERT INTO worker_job_applications (id, worker_id, job_posting_id, application_funnel_stage, source)
     VALUES ($1, $2, $3, 'INVITED', 'manual')
     ON CONFLICT (id) DO NOTHING`,
    [IDS.wja, IDS.worker, IDS.vacancy],
  );

  // WJA for other vacancy (used to test cross-vacancy 404)
  await pool.query(
    `INSERT INTO worker_job_applications (id, worker_id, job_posting_id, application_funnel_stage, source)
     VALUES ($1, $2, $3, 'INVITED', 'manual')
     ON CONFLICT (id) DO NOTHING`,
    [IDS.otherWja, IDS.worker, IDS.otherVacancy],
  );
}

async function cleanFixtures(pool: Pool): Promise<void> {
  await pool.query(
    `DELETE FROM wja_contact_notes WHERE worker_job_application_id IN ($1, $2)`,
    [IDS.wja, IDS.otherWja],
  ).catch(() => {});

  await pool.query(
    `DELETE FROM worker_job_applications WHERE id IN ($1, $2)`,
    [IDS.wja, IDS.otherWja],
  ).catch(() => {});

  await pool.query(
    `DELETE FROM encuadres WHERE job_posting_id IN ($1, $2)`,
    [IDS.vacancy, IDS.otherVacancy],
  ).catch(() => {});

  await pool.query(
    `DELETE FROM job_postings WHERE id IN ($1, $2)`,
    [IDS.vacancy, IDS.otherVacancy],
  ).catch(() => {});

  await pool.query(
    `DELETE FROM workers WHERE id = $1`,
    [IDS.worker],
  ).catch(() => {});

  await pool.query(
    `DELETE FROM patients WHERE id = $1`,
    [IDS.patient],
  ).catch(() => {});
}
