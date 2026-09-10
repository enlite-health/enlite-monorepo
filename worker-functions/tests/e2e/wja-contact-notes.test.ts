/**
 * wja-contact-notes.test.ts
 *
 * E2E tests for Worker Contact Notes feature:
 *   POST /api/admin/vacancies/:vacancyId/workers/:workerId/contact-notes
 *   GET  /api/admin/vacancies/:vacancyId/workers/:workerId/contact-notes
 *
 * Migration 235: chave re-chaveada de worker_job_application_id (WJA) para o
 * par estável (worker_id, job_posting_id) — sobrevive à promoção
 * BLOQUEADO→INICIADO. Cobre também o cenário de card BLOQUEADO (sem WJA
 * ainda) e a sobrevivência da nota após a promoção.
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
  blockedWorker: 'c0000001-0000-4000-a003-000000000002',
};

describe('Worker Contact Notes', () => {
  const api = createApiClient();
  let adminToken: string;
  let otherAdminToken: string;
  let pool: Pool;

  beforeAll(async () => {
    await waitForBackend(api);

    adminToken = await getMockToken(api, {
      uid: 'cn-admin-e2e',
      email: 'cn-admin@e2e.local',
      role: 'admin',
    });

    // Segundo operador — usado pra provar que só o autor pode excluir.
    otherAdminToken = await getMockToken(api, {
      uid: 'cn-admin-other',
      email: 'cn-admin-other@e2e.local',
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

  describe('POST /:vacancyId/workers/:workerId/contact-notes', () => {
    it('creates a note and returns 201 with noteText, createdByAdminId, createdAt', async () => {
      const res = await api.post(
        `/api/admin/vacancies/${IDS.vacancy}/workers/${IDS.worker}/contact-notes`,
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
        `/api/admin/vacancies/${IDS.vacancy}/workers/${IDS.worker}/contact-notes`,
        { noteText: longText },
        auth(),
      );

      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
    });

    it('returns 400 when noteText is empty string', async () => {
      const res = await api.post(
        `/api/admin/vacancies/${IDS.vacancy}/workers/${IDS.worker}/contact-notes`,
        { noteText: '' },
        auth(),
      );

      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
    });

    it('returns 400 when noteText is only whitespace', async () => {
      const res = await api.post(
        `/api/admin/vacancies/${IDS.vacancy}/workers/${IDS.worker}/contact-notes`,
        { noteText: '   ' },
        auth(),
      );

      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
    });

    it('returns 404 when workerId has no WJA nor blocked attempt for this vacancy', async () => {
      // otherWja pertence à IDS.otherVacancy — o par (worker, IDS.vacancy) via
      // um worker sem nenhuma postulação/tentativa não existe.
      const res = await api.post(
        `/api/admin/vacancies/${IDS.vacancy}/workers/00000000-0000-4000-a000-000000000099/contact-notes`,
        { noteText: 'Worker sem postulação nesta vaga' },
        auth(),
      );

      expect(res.status).toBe(404);
      expect(res.data.success).toBe(false);
    });

    it('returns 404 when worker belongs to a different vacancy (cross-vacancy isolation)', async () => {
      // IDS.worker tem WJA na IDS.otherVacancy também, mas o par (worker, IDS.vacancy)
      // deve ser validado — aqui testamos vacancyId errado com worker de outro par.
      const res = await api.post(
        `/api/admin/vacancies/${IDS.otherVacancy}/workers/${IDS.blockedWorker}/contact-notes`,
        { noteText: 'Blocked worker não pertence a otherVacancy' },
        auth(),
      );

      expect(res.status).toBe(404);
      expect(res.data.success).toBe(false);
    });

    it('snapshots the author display name from the users table', async () => {
      // seedFixtures inseriu users(cn-admin-e2e).display_name = 'Operadora E2E'
      const res = await api.post(
        `/api/admin/vacancies/${IDS.vacancy}/workers/${IDS.worker}/contact-notes`,
        { noteText: 'Nota com nome do autor' },
        auth(),
      );

      expect(res.status).toBe(201);
      expect(res.data.data.createdByAdminName).toBe('Operadora E2E');
      expect(res.data.data.createdByAdminEmail).toBe('cn-admin-users@e2e.local');
    });
  });

  // ── BLOQUEADO: notes on a candidate with no WJA yet ──────────────────────

  describe('Notas em card BLOQUEADO (sem WJA) — migration 235', () => {
    it('creates a note for a blocked candidate (worker_blocked_applications, no WJA yet)', async () => {
      const res = await api.post(
        `/api/admin/vacancies/${IDS.vacancy}/workers/${IDS.blockedWorker}/contact-notes`,
        { noteText: 'Contato enquanto o card ainda está bloqueado' },
        auth(),
      );

      expect(res.status).toBe(201);
      expect(res.data.success).toBe(true);

      // A nota persiste com worker_id/job_posting_id preenchidos e
      // worker_job_application_id NULL (não existe WJA para este par ainda).
      const row = await pool.query(
        `SELECT worker_id, job_posting_id, worker_job_application_id
         FROM wja_contact_notes WHERE id = $1`,
        [res.data.data.id],
      );
      expect(row.rows[0].worker_id).toBe(IDS.blockedWorker);
      expect(row.rows[0].job_posting_id).toBe(IDS.vacancy);
      expect(row.rows[0].worker_job_application_id).toBeNull();
    });

    it('lists the note for the blocked candidate via GET', async () => {
      const res = await api.get(
        `/api/admin/vacancies/${IDS.vacancy}/workers/${IDS.blockedWorker}/contact-notes`,
        auth(),
      );

      expect(res.status).toBe(200);
      const notes = res.data.data as Array<{ noteText: string }>;
      expect(notes.some(n => n.noteText === 'Contato enquanto o card ainda está bloqueado')).toBe(true);
    });

    it('a nota sobrevive à promoção: worker_job_application_id passa a ser resolvido, mas worker_id/job_posting_id continuam os mesmos', async () => {
      // Simula a promoção: nasce a WJA pro mesmo par (worker_id, job_posting_id) —
      // o que PromoteBlockedApplicationsUseCase faria no fluxo real (só pra workers
      // REGISTERED, já coberto por PromoteBlockedApplicationsUseCase.test.ts).
      // Usa source='system' aqui só pra bypassar o guard de registro completo
      // (migration 205) — irrelevante pro que este teste prova: que a nota
      // sobrevive e passa a resolver worker_job_application_id via subquery.
      const promotedWjaId = 'c0000001-0000-4000-a004-000000000099';
      await pool.query(
        `INSERT INTO worker_job_applications (id, worker_id, job_posting_id, application_funnel_stage, source)
         VALUES ($1, $2, $3, 'INVITED', 'system')
         ON CONFLICT (id) DO NOTHING`,
        [promotedWjaId, IDS.blockedWorker, IDS.vacancy],
      );

      // A nota antiga (criada quando o card ainda estava bloqueado) segue
      // aparecendo pelo mesmo par worker×vaga, mesmo sem ter sido copiada.
      const res = await api.get(
        `/api/admin/vacancies/${IDS.vacancy}/workers/${IDS.blockedWorker}/contact-notes`,
        auth(),
      );
      expect(res.status).toBe(200);
      const notes = res.data.data as Array<{ noteText: string }>;
      expect(notes.some(n => n.noteText === 'Contato enquanto o card ainda está bloqueado')).toBe(true);

      // Uma NOVA nota após a promoção resolve worker_job_application_id via subquery.
      const postPromotion = await api.post(
        `/api/admin/vacancies/${IDS.vacancy}/workers/${IDS.blockedWorker}/contact-notes`,
        { noteText: 'Nota após promoção' },
        auth(),
      );
      expect(postPromotion.status).toBe(201);

      const row = await pool.query(
        `SELECT worker_job_application_id FROM wja_contact_notes WHERE id = $1`,
        [postPromotion.data.data.id],
      );
      expect(row.rows[0].worker_job_application_id).toBe(promotedWjaId);

      await pool.query(`DELETE FROM worker_job_applications WHERE id = $1`, [promotedWjaId]);
    });
  });

  // ── DELETE: author-only + 2h window ──────────────────────────────────────

  describe('DELETE /:vacancyId/workers/:workerId/contact-notes/:noteId', () => {
    async function createNoteViaApi(noteText: string): Promise<string> {
      const res = await api.post(
        `/api/admin/vacancies/${IDS.vacancy}/workers/${IDS.worker}/contact-notes`,
        { noteText },
        auth(),
      );
      expect(res.status).toBe(201);
      return res.data.data.id as string;
    }

    it('lets the AUTHOR delete their own note within 2h (200) and removes it', async () => {
      const noteId = await createNoteViaApi('Nota a ser excluída pelo autor');

      const del = await api.delete(
        `/api/admin/vacancies/${IDS.vacancy}/workers/${IDS.worker}/contact-notes/${noteId}`,
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
        `/api/admin/vacancies/${IDS.vacancy}/workers/${IDS.worker}/contact-notes/${noteId}`,
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
      // Insere nota retroagida 3h, do mesmo autor (cn-admin-e2e), já no par novo.
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO wja_contact_notes
           (worker_id, job_posting_id, worker_job_application_id, note_text, created_by_admin_id, created_by_admin_email, created_at)
         VALUES ($1, $2, $3, 'Nota antiga (3h)', 'cn-admin-e2e', 'cn-admin@e2e.local', NOW() - INTERVAL '3 hours')
         RETURNING id`,
        [IDS.worker, IDS.vacancy, IDS.wja],
      );
      const noteId = inserted.rows[0].id;

      const del = await api.delete(
        `/api/admin/vacancies/${IDS.vacancy}/workers/${IDS.worker}/contact-notes/${noteId}`,
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
        `/api/admin/vacancies/${IDS.vacancy}/workers/${IDS.worker}/contact-notes/c0000001-0000-4000-a009-000000000099`,
        auth(),
      );
      expect(del.status).toBe(404);
      expect(del.data.success).toBe(false);
    });
  });

  // ── GET lists notes in DESC order ────────────────────────────────────────

  describe('GET /:vacancyId/workers/:workerId/contact-notes', () => {
    beforeAll(async () => {
      // Insert two notes with known timestamps (older first, then newer)
      await pool.query(
        `INSERT INTO wja_contact_notes
           (worker_id, job_posting_id, worker_job_application_id, note_text, created_by_admin_id, created_by_admin_email, created_at)
         VALUES ($1, $2, $3, 'Nota mais antiga', 'cn-admin-e2e', 'cn-admin@e2e.local', NOW() - INTERVAL '10 minutes')`,
        [IDS.worker, IDS.vacancy, IDS.wja],
      );
      await pool.query(
        `INSERT INTO wja_contact_notes
           (worker_id, job_posting_id, worker_job_application_id, note_text, created_by_admin_id, created_by_admin_email, created_at)
         VALUES ($1, $2, $3, 'Nota mais recente', 'cn-admin-e2e', 'cn-admin@e2e.local', NOW())`,
        [IDS.worker, IDS.vacancy, IDS.wja],
      );
    });

    it('returns notes in DESC order (most recent first)', async () => {
      const res = await api.get(
        `/api/admin/vacancies/${IDS.vacancy}/workers/${IDS.worker}/contact-notes`,
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

    it('returns 404 when worker has no application/attempt for this vacancy', async () => {
      const res = await api.get(
        `/api/admin/vacancies/${IDS.vacancy}/workers/00000000-0000-4000-a000-000000000098/contact-notes`,
        auth(),
      );

      expect(res.status).toBe(404);
      expect(res.data.success).toBe(false);
    });

    it('computes canDelete per note (own+recent=true, foreign=false, own+old=false)', async () => {
      await pool.query(
        `INSERT INTO wja_contact_notes
           (worker_id, job_posting_id, worker_job_application_id, note_text, created_by_admin_id, created_at)
         VALUES
           ($1, $2, $3, 'cd-own-recent', 'cn-admin-e2e', NOW()),
           ($1, $2, $3, 'cd-foreign',    'cn-admin-other', NOW()),
           ($1, $2, $3, 'cd-own-old',    'cn-admin-e2e', NOW() - INTERVAL '3 hours')`,
        [IDS.worker, IDS.vacancy, IDS.wja],
      );

      const res = await api.get(
        `/api/admin/vacancies/${IDS.vacancy}/workers/${IDS.worker}/contact-notes`,
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

    it('returns contactNotesCount matching actual notes for the pair (worker_id, job_posting_id)', async () => {
      // Count notes in DB directly for comparison — filtrado pelo par estável
      // (migration 235), não mais por worker_job_application_id.
      const dbResult = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM wja_contact_notes
         WHERE worker_id = $1 AND job_posting_id = $2`,
        [IDS.worker, IDS.vacancy],
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
     VALUES ('cn-admin-e2e', 'cn-admin-users@e2e.local', 'Operadora E2E', 'admin', true)
     ON CONFLICT (firebase_uid) DO UPDATE
       SET display_name = EXCLUDED.display_name,
           email = EXCLUDED.email,
           role = EXCLUDED.role,
           is_active = true`,
  );

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

  // Blocked worker: só tem worker_blocked_applications para IDS.vacancy — sem WJA
  // (simula um card BLOQUEADO real, que só existirá se worker.status != REGISTERED
  // ou similar; aqui o status não importa pro teste, só a existência da linha).
  await pool.query(
    `INSERT INTO workers (id, auth_uid, email, phone, status, country)
     VALUES ($1, 'cn-blocked-worker-uid', 'cn-blocked-worker@e2e.local', '+54911000098', 'INCOMPLETE_REGISTER', 'AR')
     ON CONFLICT (id) DO NOTHING`,
    [IDS.blockedWorker],
  );
  await pool.query(
    `INSERT INTO worker_blocked_applications
       (worker_id, job_posting_id, blocked_reason_at_attempt, missing_fields_at_attempt, attempt_count, acquisition_channel)
     VALUES ($1, $2, 'registration_incomplete', '["phone"]', 1, 'facebook')
     ON CONFLICT (worker_id, job_posting_id) DO NOTHING`,
    [IDS.blockedWorker, IDS.vacancy],
  );
}

async function cleanFixtures(pool: Pool): Promise<void> {
  await pool.query(
    `DELETE FROM wja_contact_notes
     WHERE worker_job_application_id IN ($1, $2)
        OR worker_id IN ($3, $4)`,
    [IDS.wja, IDS.otherWja, IDS.worker, IDS.blockedWorker],
  ).catch(() => {});

  await pool.query(
    `DELETE FROM worker_job_applications WHERE id IN ($1, $2)`,
    [IDS.wja, IDS.otherWja],
  ).catch(() => {});

  await pool.query(
    `DELETE FROM worker_blocked_applications WHERE worker_id = $1`,
    [IDS.blockedWorker],
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
    `DELETE FROM workers WHERE id IN ($1, $2)`,
    [IDS.worker, IDS.blockedWorker],
  ).catch(() => {});

  await pool.query(
    `DELETE FROM patients WHERE id = $1`,
    [IDS.patient],
  ).catch(() => {});

  await pool.query(
    `DELETE FROM users WHERE firebase_uid = 'cn-admin-e2e'`,
  ).catch(() => {});
}
