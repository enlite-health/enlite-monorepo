/**
 * wja-contact-notes.test.ts
 *
 * E2E tests for Vacancy Contact Notes feature (migration 236):
 *   POST   /api/admin/vacancies/:vacancyId/contact-notes
 *   GET    /api/admin/vacancies/:vacancyId/contact-notes
 *   DELETE /api/admin/vacancies/:vacancyId/contact-notes/:noteId
 *
 * Migration 236: a thread de comentários é escopada SOMENTE À VAGA
 * (job_posting_id) — a mesma conversa aparece idêntica em TODOS os cards da
 * vaga, qualquer candidato, qualquer coluna (inclusive BLOQUEADO). Não há
 * mais segmento /workers/:workerId na rota nem noção de par candidato×vaga.
 *
 * Also validates Feature A (registrationComplete + contactNotesCount) via:
 *   GET /api/admin/vacancies/:id/funnel-table
 */

import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

// ── Deterministic IDs ─────────────────────────────────────────────────────────

const IDS = {
  patient: 'c0000002-0000-4000-a001-000000000001',
  vacancy: 'c0000002-0000-4000-a002-000000000001',
  otherVacancy: 'c0000002-0000-4000-a002-000000000002',
  worker: 'c0000002-0000-4000-a003-000000000001',
  wja: 'c0000002-0000-4000-a004-000000000001',
};

describe('Vacancy Contact Notes (migration 236)', () => {
  const api = createApiClient();
  let adminToken: string;
  let otherAdminToken: string;
  let pool: Pool;

  beforeAll(async () => {
    await waitForBackend(api);

    adminToken = await getMockToken(api, {
      uid: 'cn2-admin-e2e',
      email: 'cn2-admin@e2e.local',
      role: 'admin',
    });

    // Segundo operador — usado pra provar que só o autor pode excluir.
    otherAdminToken = await getMockToken(api, {
      uid: 'cn2-admin-other',
      email: 'cn2-admin-other@e2e.local',
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

  function authOther() {
    return { headers: { Authorization: `Bearer ${otherAdminToken}` } };
  }

  // ── POST creates note ─────────────────────────────────────────────────────

  describe('POST /:vacancyId/contact-notes', () => {
    it('creates a note and returns 201 with noteText, createdByAdminId, createdAt', async () => {
      const res = await api.post(
        `/api/admin/vacancies/${IDS.vacancy}/contact-notes`,
        { noteText: 'Primeiro contato realizado via WhatsApp' },
        auth(),
      );

      expect(res.status).toBe(201);
      expect(res.data.success).toBe(true);
      expect(res.data.data.noteText).toBe('Primeiro contato realizado via WhatsApp');
      expect(res.data.data.createdByAdminId).toBe('cn2-admin-e2e');
      expect(typeof res.data.data.createdAt).toBe('string');
      expect(res.data.data.id).toBeTruthy();
      // Nota escopada só à vaga — sem workerId nem workerJobApplicationId no payload.
      expect(res.data.data.workerId).toBeUndefined();
      expect(res.data.data.workerJobApplicationId).toBeUndefined();
    });

    it('returns 400 when noteText exceeds 240 characters', async () => {
      const longText = 'a'.repeat(241);
      const res = await api.post(
        `/api/admin/vacancies/${IDS.vacancy}/contact-notes`,
        { noteText: longText },
        auth(),
      );

      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
    });

    it('returns 400 when noteText is empty string', async () => {
      const res = await api.post(
        `/api/admin/vacancies/${IDS.vacancy}/contact-notes`,
        { noteText: '' },
        auth(),
      );

      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
    });

    it('returns 400 when noteText is only whitespace', async () => {
      const res = await api.post(
        `/api/admin/vacancies/${IDS.vacancy}/contact-notes`,
        { noteText: '   ' },
        auth(),
      );

      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
    });

    it('returns 404 when vacancyId does not exist', async () => {
      const res = await api.post(
        `/api/admin/vacancies/00000000-0000-4000-a000-000000000099/contact-notes`,
        { noteText: 'Vaga inexistente' },
        auth(),
      );

      expect(res.status).toBe(404);
      expect(res.data.success).toBe(false);
    });

    it('snapshots the author display name from the users table', async () => {
      // seedFixtures inseriu users(cn2-admin-e2e).display_name = 'Operadora E2E'
      const res = await api.post(
        `/api/admin/vacancies/${IDS.vacancy}/contact-notes`,
        { noteText: 'Nota com nome do autor' },
        auth(),
      );

      expect(res.status).toBe(201);
      expect(res.data.data.createdByAdminName).toBe('Operadora E2E');
      expect(res.data.data.createdByAdminEmail).toBe('cn2-admin-users@e2e.local');
    });
  });

  // ── Thread única por vaga ─────────────────────────────────────────────────

  describe('Thread única por vaga — migration 236', () => {
    it('a nota criada sem nenhum candidato/WJA associado é visível (escopo é só a vaga)', async () => {
      // otherVacancy não tem NENHUM worker/WJA/blocked attempt — prova que a
      // nota depende só da vaga existir, não de haver candidato algum.
      const res = await api.post(
        `/api/admin/vacancies/${IDS.otherVacancy}/contact-notes`,
        { noteText: 'Nota em vaga sem nenhum candidato ainda' },
        auth(),
      );

      expect(res.status).toBe(201);
      expect(res.data.success).toBe(true);

      const list = await api.get(
        `/api/admin/vacancies/${IDS.otherVacancy}/contact-notes`,
        auth(),
      );
      expect(list.status).toBe(200);
      const notes = list.data.data as Array<{ noteText: string }>;
      expect(notes.some(n => n.noteText === 'Nota em vaga sem nenhum candidato ainda')).toBe(true);
    });

    it('a lista de notas da vaga é isolada de outra vaga (cross-vacancy)', async () => {
      const list = await api.get(
        `/api/admin/vacancies/${IDS.vacancy}/contact-notes`,
        auth(),
      );
      expect(list.status).toBe(200);
      const notes = list.data.data as Array<{ noteText: string }>;
      expect(notes.some(n => n.noteText === 'Nota em vaga sem nenhum candidato ainda')).toBe(false);
    });
  });

  // ── DELETE: author-only + 2h window ──────────────────────────────────────

  describe('DELETE /:vacancyId/contact-notes/:noteId', () => {
    async function createNoteViaApi(noteText: string): Promise<string> {
      const res = await api.post(
        `/api/admin/vacancies/${IDS.vacancy}/contact-notes`,
        { noteText },
        auth(),
      );
      expect(res.status).toBe(201);
      return res.data.data.id as string;
    }

    it('lets the AUTHOR delete their own note within 2h (200) and removes it', async () => {
      const noteId = await createNoteViaApi('Nota a ser excluída pelo autor');

      const del = await api.delete(
        `/api/admin/vacancies/${IDS.vacancy}/contact-notes/${noteId}`,
        auth(),
      );
      expect(del.status).toBe(200);
      expect(del.data.success).toBe(true);

      const check = await pool.query(
        `SELECT 1 FROM wja_contact_notes WHERE id = $1`,
        [noteId],
      );
      expect(check.rowCount).toBe(0);
    });

    it('forbids a NON-author from deleting the note (403 not_owner) and keeps it', async () => {
      const noteId = await createNoteViaApi('Nota do autor, outro tenta excluir');

      const del = await api.delete(
        `/api/admin/vacancies/${IDS.vacancy}/contact-notes/${noteId}`,
        authOther(),
      );
      expect(del.status).toBe(403);
      expect(del.data.success).toBe(false);
      expect(del.data.reason).toBe('not_owner');

      const check = await pool.query(
        `SELECT 1 FROM wja_contact_notes WHERE id = $1`,
        [noteId],
      );
      expect(check.rowCount).toBe(1);
    });

    it('forbids the author from deleting after 2h (403 window_expired) and keeps it', async () => {
      // Insere nota retroagida 3h, do mesmo autor (cn2-admin-e2e).
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO wja_contact_notes
           (job_posting_id, note_text, created_by_admin_id, created_by_admin_email, created_at)
         VALUES ($1, 'Nota antiga (3h)', 'cn2-admin-e2e', 'cn2-admin@e2e.local', NOW() - INTERVAL '3 hours')
         RETURNING id`,
        [IDS.vacancy],
      );
      const noteId = inserted.rows[0].id;

      const del = await api.delete(
        `/api/admin/vacancies/${IDS.vacancy}/contact-notes/${noteId}`,
        auth(),
      );
      expect(del.status).toBe(403);
      expect(del.data.success).toBe(false);
      expect(del.data.reason).toBe('window_expired');

      const check = await pool.query(
        `SELECT 1 FROM wja_contact_notes WHERE id = $1`,
        [noteId],
      );
      expect(check.rowCount).toBe(1);
    });

    it('returns 404 for an unknown noteId', async () => {
      const del = await api.delete(
        `/api/admin/vacancies/${IDS.vacancy}/contact-notes/c0000002-0000-4000-a009-000000000099`,
        auth(),
      );
      expect(del.status).toBe(404);
      expect(del.data.success).toBe(false);
    });

    it('returns 404 when the note belongs to a DIFFERENT vacancy', async () => {
      const noteId = await createNoteViaApi('Nota da vaga principal');

      const del = await api.delete(
        `/api/admin/vacancies/${IDS.otherVacancy}/contact-notes/${noteId}`,
        auth(),
      );
      expect(del.status).toBe(404);
      expect(del.data.success).toBe(false);
    });
  });

  // ── GET lists notes in DESC order ────────────────────────────────────────

  describe('GET /:vacancyId/contact-notes', () => {
    beforeAll(async () => {
      // Insert two notes with known timestamps (older first, then newer)
      await pool.query(
        `INSERT INTO wja_contact_notes
           (job_posting_id, note_text, created_by_admin_id, created_by_admin_email, created_at)
         VALUES ($1, 'Nota mais antiga', 'cn2-admin-e2e', 'cn2-admin@e2e.local', NOW() - INTERVAL '10 minutes')`,
        [IDS.vacancy],
      );
      await pool.query(
        `INSERT INTO wja_contact_notes
           (job_posting_id, note_text, created_by_admin_id, created_by_admin_email, created_at)
         VALUES ($1, 'Nota mais recente', 'cn2-admin-e2e', 'cn2-admin@e2e.local', NOW())`,
        [IDS.vacancy],
      );
    });

    it('returns notes in DESC order (most recent first)', async () => {
      const res = await api.get(
        `/api/admin/vacancies/${IDS.vacancy}/contact-notes`,
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

    it('returns 404 when vacancy does not exist', async () => {
      const res = await api.get(
        `/api/admin/vacancies/00000000-0000-4000-a000-000000000098/contact-notes`,
        auth(),
      );

      expect(res.status).toBe(404);
      expect(res.data.success).toBe(false);
    });

    it('computes canDelete per note (own+recent=true, foreign=false, own+old=false)', async () => {
      await pool.query(
        `INSERT INTO wja_contact_notes
           (job_posting_id, note_text, created_by_admin_id, created_at)
         VALUES
           ($1, 'cd-own-recent', 'cn2-admin-e2e', NOW()),
           ($1, 'cd-foreign',    'cn2-admin-other', NOW()),
           ($1, 'cd-own-old',    'cn2-admin-e2e', NOW() - INTERVAL '3 hours')`,
        [IDS.vacancy],
      );

      const res = await api.get(
        `/api/admin/vacancies/${IDS.vacancy}/contact-notes`,
        auth(),
      );
      expect(res.status).toBe(200);
      const notes = res.data.data as Array<{ noteText: string; canDelete: boolean }>;
      expect(notes.find(n => n.noteText === 'cd-own-recent')?.canDelete).toBe(true);
      expect(notes.find(n => n.noteText === 'cd-foreign')?.canDelete).toBe(false);
      expect(notes.find(n => n.noteText === 'cd-own-old')?.canDelete).toBe(false);
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

    it('returns contactNotesCount matching the VAGA total (migration 236 — escopo só-vaga)', async () => {
      // Count notes in DB directly for comparison — filtrado só pela vaga
      // (migration 236), não mais por worker.
      const dbResult = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM wja_contact_notes
         WHERE job_posting_id = $1`,
        [IDS.vacancy],
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

  // Staff user (autor das notas) — fonte do display_name p/ o snapshot do nome.
  await pool.query(
    `INSERT INTO users (firebase_uid, email, display_name, role, is_active)
     VALUES ('cn2-admin-e2e', 'cn2-admin-users@e2e.local', 'Operadora E2E', 'admin', true)
     ON CONFLICT (firebase_uid) DO UPDATE
       SET display_name = EXCLUDED.display_name,
           email = EXCLUDED.email,
           role = EXCLUDED.role,
           is_active = true`,
  );

  // Patient
  await pool.query(
    `INSERT INTO patients (id, clickup_task_id, country, first_name, last_name)
     VALUES ($1, 'cn2-e2e-task-001', 'AR', 'CnTest', 'Patient')
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
     VALUES ($1, $2, 99201, $3, 'cn2-e2e-vacancy', '', 'AR', 'SEARCHING')
     ON CONFLICT (id) DO NOTHING`,
    [IDS.vacancy, vn1, IDS.patient],
  );

  // Other vacancy (used for cross-vacancy isolation test)
  await pool.query(
    `INSERT INTO job_postings (id, vacancy_number, case_number, patient_id, title, description, country, status)
     VALUES ($1, $2, 99202, $3, 'cn2-e2e-other-vacancy', '', 'AR', 'SEARCHING')
     ON CONFLICT (id) DO NOTHING`,
    [IDS.otherVacancy, vn2, IDS.patient],
  );

  // Worker with status=REGISTERED (required: migration 183 blocks WJA for non-REGISTERED workers)
  await pool.query(
    `INSERT INTO workers (id, auth_uid, email, phone, status, country)
     VALUES ($1, 'cn2-worker-uid', 'cn2-worker@e2e.local', '+54911000199', 'REGISTERED', 'AR')
     ON CONFLICT (id) DO NOTHING`,
    [IDS.worker],
  );

  // WJA for main vacancy — usado só pelo teste de funnel-table (Feature A).
  await pool.query(
    `INSERT INTO worker_job_applications (id, worker_id, job_posting_id, application_funnel_stage, source)
     VALUES ($1, $2, $3, 'INVITED', 'manual')
     ON CONFLICT (id) DO NOTHING`,
    [IDS.wja, IDS.worker, IDS.vacancy],
  );
}

async function cleanFixtures(pool: Pool): Promise<void> {
  await pool.query(
    `DELETE FROM wja_contact_notes WHERE job_posting_id IN ($1, $2)`,
    [IDS.vacancy, IDS.otherVacancy],
  ).catch(() => {});

  await pool.query(
    `DELETE FROM worker_job_applications WHERE id = $1`,
    [IDS.wja],
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

  await pool.query(
    `DELETE FROM users WHERE firebase_uid = 'cn2-admin-e2e'`,
  ).catch(() => {});
}
