/**
 * contact-note-repository.integration.test.ts
 *
 * Testes de integração com banco REAL para ContactNoteRepository — migration
 * 235 (re-chaveamento de worker_job_application_id para o par estável
 * worker_id + job_posting_id).
 *
 * Não usa API — acessa pool diretamente. INVARIANTE: migration 235 aplicada.
 *
 * Cenários:
 *   1. insert() — par com WJA existente resolve worker_job_application_id via subquery
 *   2. insert() — par SEM WJA (só worker_blocked_applications) grava worker_job_application_id NULL
 *   3. findByWorkerAndVacancy() — filtra pelo par, ORDER BY created_at DESC
 *   4. findByWorkerAndVacancy() — isolamento entre vagas diferentes do mesmo worker
 *   5. findOwnershipById() — retorna workerId/jobPostingId corretos; null se não existir
 *   6. deleteById() — remove fisicamente, idempotente
 *   7. validateCandidateVacancyPair() — true com WJA; true com blocked; false sem nenhum
 *   8. nota sobrevive à promoção: criada com par sem WJA, continua visível após WJA nascer
 */

import { Pool } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const pool = new Pool({ connectionString: DATABASE_URL });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ContactNoteRepository } = require('../../src/modules/matching/infrastructure/ContactNoteRepository') as typeof import('../../src/modules/matching/infrastructure/ContactNoteRepository');

const SUFFIX = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
let PATIENT_ID: string;
let VACANCY_ID: string;
let OTHER_VACANCY_ID: string;
const WORKER_IDS: string[] = [];
const NOTE_IDS: string[] = [];

async function makeWorker(tag: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO workers (auth_uid, email, status, country, timezone)
     VALUES ($1, $2, 'REGISTERED', 'AR', 'America/Argentina/Buenos_Aires') RETURNING id`,
    [`uid-cnrepo-${SUFFIX}-${tag}`, `cnrepo-${SUFFIX}-${tag}@e2e.test`],
  );
  WORKER_IDS.push(rows[0].id);
  return rows[0].id;
}

beforeAll(async () => {
  const { rows: pRows } = await pool.query<{ id: string }>(
    `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
     VALUES ($1, 'E2E', 'CnRepo', 'AR', 'ACTIVE') RETURNING id`,
    [`e2e-cnrepo-${SUFFIX}`],
  );
  PATIENT_ID = pRows[0].id;

  const { rows: vRows } = await pool.query<{ id: string }>(
    `INSERT INTO job_postings (title, country, status, patient_id, case_number)
     VALUES ('Vaga CnRepo', 'AR', 'SEARCHING', $1, 99995) RETURNING id`,
    [PATIENT_ID],
  );
  VACANCY_ID = vRows[0].id;

  const { rows: v2Rows } = await pool.query<{ id: string }>(
    `INSERT INTO job_postings (title, country, status, patient_id, case_number)
     VALUES ('Vaga CnRepo Other', 'AR', 'SEARCHING', $1, 99996) RETURNING id`,
    [PATIENT_ID],
  );
  OTHER_VACANCY_ID = v2Rows[0].id;
});

afterAll(async () => {
  if (NOTE_IDS.length) {
    await pool.query(`DELETE FROM wja_contact_notes WHERE id = ANY($1::uuid[])`, [NOTE_IDS]);
  }
  if (WORKER_IDS.length) {
    await pool.query(`DELETE FROM worker_job_applications WHERE worker_id = ANY($1::uuid[])`, [WORKER_IDS]);
    await pool.query(`DELETE FROM worker_blocked_applications WHERE worker_id = ANY($1::uuid[])`, [WORKER_IDS]);
    await pool.query(`DELETE FROM workers WHERE id = ANY($1::uuid[])`, [WORKER_IDS]);
  }
  await pool.query(`DELETE FROM job_postings WHERE id = ANY($1::uuid[])`, [[VACANCY_ID, OTHER_VACANCY_ID]]);
  await pool.query(`DELETE FROM patients WHERE id = $1`, [PATIENT_ID]);
  await pool.end();
});

describe('ContactNoteRepository (banco real — migration 235)', () => {
  it('insert() resolve worker_job_application_id via subquery quando o par já tem WJA', async () => {
    const workerId = await makeWorker('insert-with-wja');
    await pool.query(
      `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
       VALUES ($1, $2, 'INVITED', 'manual')`,
      [workerId, VACANCY_ID],
    );

    const repo = new ContactNoteRepository();
    const note = await repo.insert({
      workerId,
      jobPostingId: VACANCY_ID,
      noteText: 'Nota com WJA existente',
      createdByAdminId: 'admin-repo-1',
      createdByAdminName: 'Admin Teste',
      createdByAdminEmail: 'admin@e2e.local',
    });
    NOTE_IDS.push(note.id);

    expect(note.workerId).toBe(workerId);
    expect(note.jobPostingId).toBe(VACANCY_ID);
    expect(note.workerJobApplicationId).not.toBeNull();

    const { rows } = await pool.query(
      `SELECT worker_job_application_id FROM wja_contact_notes WHERE id = $1`,
      [note.id],
    );
    expect(rows[0].worker_job_application_id).toBe(note.workerJobApplicationId);
  });

  it('insert() grava worker_job_application_id NULL quando só existe worker_blocked_applications (card ainda BLOQUEADO)', async () => {
    const workerId = await makeWorker('insert-blocked-only');
    await pool.query(
      `INSERT INTO worker_blocked_applications (worker_id, job_posting_id, blocked_reason, missing_fields, attempt_count)
       VALUES ($1, $2, 'registration_incomplete', '["phone"]', 1)`,
      [workerId, VACANCY_ID],
    );

    const repo = new ContactNoteRepository();
    const note = await repo.insert({
      workerId,
      jobPostingId: VACANCY_ID,
      noteText: 'Nota em card bloqueado (sem WJA)',
      createdByAdminId: 'admin-repo-1',
      createdByAdminName: null,
      createdByAdminEmail: null,
    });
    NOTE_IDS.push(note.id);

    expect(note.workerJobApplicationId).toBeNull();
  });

  it('nota sobrevive à promoção: criada sem WJA, permanece visível pelo par depois que a WJA nasce', async () => {
    const workerId = await makeWorker('survives-promotion');
    await pool.query(
      `INSERT INTO worker_blocked_applications (worker_id, job_posting_id, blocked_reason, missing_fields, attempt_count)
       VALUES ($1, $2, 'registration_incomplete', '["phone"]', 1)`,
      [workerId, VACANCY_ID],
    );

    const repo = new ContactNoteRepository();
    const note = await repo.insert({
      workerId,
      jobPostingId: VACANCY_ID,
      noteText: 'Nota antes da promoção',
      createdByAdminId: 'admin-repo-1',
      createdByAdminName: null,
      createdByAdminEmail: null,
    });
    NOTE_IDS.push(note.id);
    expect(note.workerJobApplicationId).toBeNull();

    // Promoção: nasce a WJA para o mesmo par (o que PromoteBlockedApplicationsUseCase faria)
    await pool.query(
      `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
       VALUES ($1, $2, 'INVITED', 'manual')`,
      [workerId, VACANCY_ID],
    );

    const notesAfterPromotion = await repo.findByWorkerAndVacancy(workerId, VACANCY_ID);
    expect(notesAfterPromotion.some(n => n.id === note.id)).toBe(true);
  });

  it('findByWorkerAndVacancy() ordena por created_at DESC e isola por vaga', async () => {
    const workerId = await makeWorker('find-order-isolation');
    await pool.query(
      `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
       VALUES ($1, $2, 'INVITED', 'manual'), ($1, $3, 'INVITED', 'manual')`,
      [workerId, VACANCY_ID, OTHER_VACANCY_ID],
    );

    const repo = new ContactNoteRepository();
    const older = await repo.insert({
      workerId, jobPostingId: VACANCY_ID, noteText: 'mais antiga',
      createdByAdminId: 'admin-repo-1', createdByAdminName: null, createdByAdminEmail: null,
    });
    NOTE_IDS.push(older.id);
    const newer = await repo.insert({
      workerId, jobPostingId: VACANCY_ID, noteText: 'mais recente',
      createdByAdminId: 'admin-repo-1', createdByAdminName: null, createdByAdminEmail: null,
    });
    NOTE_IDS.push(newer.id);
    const otherVacancyNote = await repo.insert({
      workerId, jobPostingId: OTHER_VACANCY_ID, noteText: 'outra vaga',
      createdByAdminId: 'admin-repo-1', createdByAdminName: null, createdByAdminEmail: null,
    });
    NOTE_IDS.push(otherVacancyNote.id);

    const notes = await repo.findByWorkerAndVacancy(workerId, VACANCY_ID);
    expect(notes.map(n => n.noteText)).toEqual(['mais recente', 'mais antiga']);
    expect(notes.every(n => n.jobPostingId === VACANCY_ID)).toBe(true);
  });

  it('findOwnershipById() retorna workerId/jobPostingId; null para id inexistente', async () => {
    const workerId = await makeWorker('ownership');
    await pool.query(
      `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
       VALUES ($1, $2, 'INVITED', 'manual')`,
      [workerId, VACANCY_ID],
    );

    const repo = new ContactNoteRepository();
    const note = await repo.insert({
      workerId, jobPostingId: VACANCY_ID, noteText: 'ownership check',
      createdByAdminId: 'admin-repo-1', createdByAdminName: null, createdByAdminEmail: null,
    });
    NOTE_IDS.push(note.id);

    const ownership = await repo.findOwnershipById(note.id);
    expect(ownership).toEqual({
      id: note.id,
      workerId,
      jobPostingId: VACANCY_ID,
      createdByAdminId: 'admin-repo-1',
      createdAt: note.createdAt,
    });

    const missing = await repo.findOwnershipById('00000000-0000-0000-0000-000000000000');
    expect(missing).toBeNull();
  });

  it('deleteById() remove fisicamente e é idempotente', async () => {
    const workerId = await makeWorker('delete');
    await pool.query(
      `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
       VALUES ($1, $2, 'INVITED', 'manual')`,
      [workerId, VACANCY_ID],
    );

    const repo = new ContactNoteRepository();
    const note = await repo.insert({
      workerId, jobPostingId: VACANCY_ID, noteText: 'a ser deletada',
      createdByAdminId: 'admin-repo-1', createdByAdminName: null, createdByAdminEmail: null,
    });

    await repo.deleteById(note.id);
    const { rows } = await pool.query(`SELECT 1 FROM wja_contact_notes WHERE id = $1`, [note.id]);
    expect(rows).toHaveLength(0);

    // Idempotente: segunda chamada não lança
    await expect(repo.deleteById(note.id)).resolves.toBeUndefined();
  });

  describe('validateCandidateVacancyPair()', () => {
    it('true quando existe WJA para o par', async () => {
      const workerId = await makeWorker('validate-wja');
      await pool.query(
        `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
         VALUES ($1, $2, 'INVITED', 'manual')`,
        [workerId, VACANCY_ID],
      );

      const repo = new ContactNoteRepository();
      expect(await repo.validateCandidateVacancyPair(workerId, VACANCY_ID)).toBe(true);
    });

    it('true quando existe apenas worker_blocked_applications para o par', async () => {
      const workerId = await makeWorker('validate-blocked');
      await pool.query(
        `INSERT INTO worker_blocked_applications (worker_id, job_posting_id, blocked_reason, missing_fields, attempt_count)
         VALUES ($1, $2, 'registration_incomplete', '["phone"]', 1)`,
        [workerId, VACANCY_ID],
      );

      const repo = new ContactNoteRepository();
      expect(await repo.validateCandidateVacancyPair(workerId, VACANCY_ID)).toBe(true);
    });

    it('false quando não existe WJA nem worker_blocked_applications para o par', async () => {
      const workerId = await makeWorker('validate-none');

      const repo = new ContactNoteRepository();
      expect(await repo.validateCandidateVacancyPair(workerId, VACANCY_ID)).toBe(false);
    });
  });
});
