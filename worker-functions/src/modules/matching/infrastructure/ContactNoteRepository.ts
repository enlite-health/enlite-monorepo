import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import {
  ContactNote,
  ContactNoteOwnership,
  CreateContactNoteInput,
} from '../domain/ContactNote';

interface ContactNoteRow {
  id: string;
  worker_id: string;
  job_posting_id: string;
  worker_job_application_id: string | null;
  note_text: string;
  created_by_admin_id: string;
  created_by_admin_name: string | null;
  created_by_admin_email: string | null;
  created_at: string;
}

const SELECT_COLUMNS = `
  id,
  worker_id,
  job_posting_id,
  worker_job_application_id,
  note_text,
  created_by_admin_id,
  created_by_admin_name,
  created_by_admin_email,
  created_at::text AS created_at`;

function mapRow(row: ContactNoteRow): ContactNote {
  return {
    id: row.id,
    workerId: row.worker_id,
    jobPostingId: row.job_posting_id,
    workerJobApplicationId: row.worker_job_application_id ?? null,
    noteText: row.note_text,
    createdByAdminId: row.created_by_admin_id,
    createdByAdminName: row.created_by_admin_name ?? null,
    createdByAdminEmail: row.created_by_admin_email ?? null,
    createdAt: row.created_at,
  };
}

/**
 * ContactNoteRepository
 *
 * Persistência de notas de contato por par estável candidato×vaga
 * (worker_id, job_posting_id) — migration 235 (antes: worker_job_application_id).
 * Tabela: wja_contact_notes (migration 204; nome do autor em migration 232;
 * re-chaveada para o par worker×vaga em migration 235).
 * Exclusão permitida só pelo autor e dentro da janela de 2h — regra aplicada
 * no DeleteContactNoteUseCase, não no SQL.
 */
export class ContactNoteRepository {
  private pool: Pool;

  constructor() {
    this.pool = DatabaseConnection.getInstance().getPool();
  }

  /**
   * Insere a nota escopada ao par (worker_id, job_posting_id). O
   * worker_job_application_id legado é resolvido best-effort via subquery:
   * se já existir uma WJA para o par (candidato promovido/postulação real),
   * fica preenchido; senão fica NULL (ex: card ainda BLOQUEADO).
   */
  async insert(input: CreateContactNoteInput): Promise<ContactNote> {
    const result = await this.pool.query<ContactNoteRow>(
      `INSERT INTO wja_contact_notes
         (worker_id, job_posting_id, worker_job_application_id,
          note_text, created_by_admin_id, created_by_admin_name, created_by_admin_email)
       VALUES (
         $1, $2,
         (SELECT id FROM worker_job_applications WHERE worker_id = $1 AND job_posting_id = $2),
         $3, $4, $5, $6
       )
       RETURNING ${SELECT_COLUMNS}`,
      [
        input.workerId,
        input.jobPostingId,
        input.noteText,
        input.createdByAdminId,
        input.createdByAdminName ?? null,
        input.createdByAdminEmail ?? null,
      ],
    );

    return mapRow(result.rows[0]);
  }

  async findByWorkerAndVacancy(workerId: string, vacancyId: string): Promise<ContactNote[]> {
    const result = await this.pool.query<ContactNoteRow>(
      `SELECT ${SELECT_COLUMNS}
       FROM wja_contact_notes
       WHERE worker_id = $1 AND job_posting_id = $2
       ORDER BY created_at DESC`,
      [workerId, vacancyId],
    );

    return result.rows.map(mapRow);
  }

  /**
   * Retorna apenas par (worker/vaga) + autor + timestamp da nota, pros guards
   * de exclusão. null se a nota não existir.
   */
  async findOwnershipById(noteId: string): Promise<ContactNoteOwnership | null> {
    const result = await this.pool.query<{
      id: string;
      worker_id: string;
      job_posting_id: string;
      created_by_admin_id: string;
      created_at: string;
    }>(
      `SELECT
         id,
         worker_id,
         job_posting_id,
         created_by_admin_id,
         created_at::text AS created_at
       FROM wja_contact_notes
       WHERE id = $1`,
      [noteId],
    );

    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      workerId: row.worker_id,
      jobPostingId: row.job_posting_id,
      createdByAdminId: row.created_by_admin_id,
      createdAt: row.created_at,
    };
  }

  /** Remove a nota fisicamente. Idempotente (no-op se já não existir). */
  async deleteById(noteId: string): Promise<void> {
    await this.pool.query(`DELETE FROM wja_contact_notes WHERE id = $1`, [noteId]);
  }

  /**
   * Verifica se o par (worker_id, job_posting_id) é um candidato válido pra
   * vacante informada — postulação real (worker_job_applications) OU
   * tentativa bloqueada (worker_blocked_applications). Usado como guard de
   * pertencimento antes de operar sobre notas.
   */
  async validateCandidateVacancyPair(workerId: string, vacancyId: string): Promise<boolean> {
    const result = await this.pool.query<{ exists: boolean }>(
      `SELECT (
         EXISTS (
           SELECT 1 FROM worker_job_applications
           WHERE worker_id = $1 AND job_posting_id = $2
         )
         OR EXISTS (
           SELECT 1 FROM worker_blocked_applications
           WHERE worker_id = $1 AND job_posting_id = $2
         )
       ) AS exists`,
      [workerId, vacancyId],
    );
    return result.rows[0].exists;
  }
}
