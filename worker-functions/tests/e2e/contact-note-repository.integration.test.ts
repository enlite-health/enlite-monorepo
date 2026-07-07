/**
 * contact-note-repository.integration.test.ts
 *
 * Testes de integração com banco REAL para ContactNoteRepository — migration
 * 236 (escopo SOMENTE À VAGA, job_posting_id). A thread de notas é única por
 * vaga: qualquer candidato/card da mesma vaga vê e escreve na MESMA lista de
 * notas. worker_id e worker_job_application_id não existem mais (migration
 * 236 as renomeou para *_deprecated_20260707 — nenhum código as lê).
 *
 * Não usa API — acessa pool diretamente. INVARIANTE: migration 236 aplicada.
 *
 * Cenários:
 *   1. insert() — grava só job_posting_id/note_text/autor
 *   2. findByVacancy() — filtra pela vaga, ORDER BY created_at DESC
 *   3. findByVacancy() — isolamento entre vagas diferentes
 *   4. findByVacancy() — mesma thread aparece para QUALQUER candidato da vaga
 *      (a nota não pertence a nenhum worker específico)
 *   5. findOwnershipById() — retorna jobPostingId correto; null se não existir
 *   6. deleteById() — remove fisicamente, idempotente
 *   7. validateVacancyExists() — true quando a vaga existe; false caso contrário
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
const NOTE_IDS: string[] = [];

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
  await pool.query(`DELETE FROM job_postings WHERE id = ANY($1::uuid[])`, [[VACANCY_ID, OTHER_VACANCY_ID]]);
  await pool.query(`DELETE FROM patients WHERE id = $1`, [PATIENT_ID]);
  await pool.end();
});

describe('ContactNoteRepository (banco real — migration 236, escopo só-vaga)', () => {
  it('insert() grava só job_posting_id/note_text/autor', async () => {
    const repo = new ContactNoteRepository();
    const note = await repo.insert({
      jobPostingId: VACANCY_ID,
      noteText: 'Nota escopada à vaga',
      createdByAdminId: 'admin-repo-1',
      createdByAdminName: 'Admin Teste',
      createdByAdminEmail: 'admin@e2e.local',
    });
    NOTE_IDS.push(note.id);

    expect(note.jobPostingId).toBe(VACANCY_ID);
    expect(note).not.toHaveProperty('workerId');
    expect(note).not.toHaveProperty('workerJobApplicationId');

    const { rows } = await pool.query(
      `SELECT job_posting_id FROM wja_contact_notes WHERE id = $1`,
      [note.id],
    );
    expect(rows[0].job_posting_id).toBe(VACANCY_ID);
  });

  it('findByVacancy() ordena por created_at DESC e isola por vaga', async () => {
    const repo = new ContactNoteRepository();
    const older = await repo.insert({
      jobPostingId: VACANCY_ID, noteText: 'mais antiga',
      createdByAdminId: 'admin-repo-1', createdByAdminName: null, createdByAdminEmail: null,
    });
    NOTE_IDS.push(older.id);
    const newer = await repo.insert({
      jobPostingId: VACANCY_ID, noteText: 'mais recente',
      createdByAdminId: 'admin-repo-1', createdByAdminName: null, createdByAdminEmail: null,
    });
    NOTE_IDS.push(newer.id);
    const otherVacancyNote = await repo.insert({
      jobPostingId: OTHER_VACANCY_ID, noteText: 'outra vaga',
      createdByAdminId: 'admin-repo-1', createdByAdminName: null, createdByAdminEmail: null,
    });
    NOTE_IDS.push(otherVacancyNote.id);

    const notes = await repo.findByVacancy(VACANCY_ID);
    expect(notes.some(n => n.id === otherVacancyNote.id)).toBe(false); // isolamento por vaga
    expect(notes.every(n => n.jobPostingId === VACANCY_ID)).toBe(true);

    const idxNewer = notes.findIndex(n => n.id === newer.id);
    const idxOlder = notes.findIndex(n => n.id === older.id);
    expect(idxNewer).toBeGreaterThanOrEqual(0);
    expect(idxOlder).toBeGreaterThanOrEqual(0);
    expect(idxNewer).toBeLessThan(idxOlder); // DESC: mais recente primeiro
  });

  it('findByVacancy() retorna a MESMA thread independente de qual candidato/card consultou — é escopada só à vaga', async () => {
    // Não há noção de "candidato" no repositório: a nota é escopada só à vaga.
    // Duas notas diferentes na mesma vaga aparecem juntas pra qualquer consumidor.
    const repo = new ContactNoteRepository();
    const noteA = await repo.insert({
      jobPostingId: VACANCY_ID, noteText: 'thread única A',
      createdByAdminId: 'admin-repo-1', createdByAdminName: null, createdByAdminEmail: null,
    });
    NOTE_IDS.push(noteA.id);
    const noteB = await repo.insert({
      jobPostingId: VACANCY_ID, noteText: 'thread única B',
      createdByAdminId: 'admin-repo-2', createdByAdminName: null, createdByAdminEmail: null,
    });
    NOTE_IDS.push(noteB.id);

    const notes = await repo.findByVacancy(VACANCY_ID);
    const texts = notes.map(n => n.noteText);
    expect(texts).toEqual(expect.arrayContaining(['thread única A', 'thread única B']));
  });

  it('findOwnershipById() retorna jobPostingId; null para id inexistente', async () => {
    const repo = new ContactNoteRepository();
    const note = await repo.insert({
      jobPostingId: VACANCY_ID, noteText: 'ownership check',
      createdByAdminId: 'admin-repo-1', createdByAdminName: null, createdByAdminEmail: null,
    });
    NOTE_IDS.push(note.id);

    const ownership = await repo.findOwnershipById(note.id);
    expect(ownership).toEqual({
      id: note.id,
      jobPostingId: VACANCY_ID,
      createdByAdminId: 'admin-repo-1',
      createdAt: note.createdAt,
    });

    const missing = await repo.findOwnershipById('00000000-0000-0000-0000-000000000000');
    expect(missing).toBeNull();
  });

  it('deleteById() remove fisicamente e é idempotente', async () => {
    const repo = new ContactNoteRepository();
    const note = await repo.insert({
      jobPostingId: VACANCY_ID, noteText: 'a ser deletada',
      createdByAdminId: 'admin-repo-1', createdByAdminName: null, createdByAdminEmail: null,
    });

    await repo.deleteById(note.id);
    const { rows } = await pool.query(`SELECT 1 FROM wja_contact_notes WHERE id = $1`, [note.id]);
    expect(rows).toHaveLength(0);

    // Idempotente: segunda chamada não lança
    await expect(repo.deleteById(note.id)).resolves.toBeUndefined();
  });

  describe('validateVacancyExists()', () => {
    it('true quando a vaga existe', async () => {
      const repo = new ContactNoteRepository();
      expect(await repo.validateVacancyExists(VACANCY_ID)).toBe(true);
    });

    it('false quando a vaga não existe', async () => {
      const repo = new ContactNoteRepository();
      expect(await repo.validateVacancyExists('00000000-0000-0000-0000-000000000000')).toBe(false);
    });
  });
});
