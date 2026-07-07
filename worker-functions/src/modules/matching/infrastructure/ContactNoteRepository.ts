import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import {
  ContactNote,
  ContactNoteOwnership,
  CreateContactNoteInput,
} from '../domain/ContactNote';

interface ContactNoteRow {
  id: string;
  job_posting_id: string;
  note_text: string;
  created_by_admin_id: string;
  created_by_admin_name: string | null;
  created_by_admin_email: string | null;
  created_at: string;
}

const SELECT_COLUMNS = `
  id,
  job_posting_id,
  note_text,
  created_by_admin_id,
  created_by_admin_name,
  created_by_admin_email,
  created_at::text AS created_at`;

function mapRow(row: ContactNoteRow): ContactNote {
  return {
    id: row.id,
    jobPostingId: row.job_posting_id,
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
 * Persistência de notas de contato escopadas SOMENTE À VAGA (job_posting_id)
 * — migration 236. A thread é única por vaga: aparece idêntica em todos os
 * cards/candidatos daquela vaga. Tabela: wja_contact_notes (migration 204;
 * nome do autor em migration 232; re-chaveada pro par worker×vaga em
 * migration 235; escopo final só-vaga em migration 236 — worker_id e
 * worker_job_application_id removidos por redundância).
 * Exclusão permitida só pelo autor e dentro da janela de 2h — regra aplicada
 * no DeleteContactNoteUseCase, não no SQL.
 */
export class ContactNoteRepository {
  private pool: Pool;

  constructor() {
    this.pool = DatabaseConnection.getInstance().getPool();
  }

  /** Insere a nota escopada à vaga (job_posting_id). */
  async insert(input: CreateContactNoteInput): Promise<ContactNote> {
    const result = await this.pool.query<ContactNoteRow>(
      `INSERT INTO wja_contact_notes
         (job_posting_id, note_text, created_by_admin_id, created_by_admin_name, created_by_admin_email)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${SELECT_COLUMNS}`,
      [
        input.jobPostingId,
        input.noteText,
        input.createdByAdminId,
        input.createdByAdminName ?? null,
        input.createdByAdminEmail ?? null,
      ],
    );

    return mapRow(result.rows[0]);
  }

  /** Lista todas as notas da vaga (mesma thread para qualquer card). */
  async findByVacancy(vacancyId: string): Promise<ContactNote[]> {
    const result = await this.pool.query<ContactNoteRow>(
      `SELECT ${SELECT_COLUMNS}
       FROM wja_contact_notes
       WHERE job_posting_id = $1
       ORDER BY created_at DESC`,
      [vacancyId],
    );

    return result.rows.map(mapRow);
  }

  /**
   * Retorna apenas vaga + autor + timestamp da nota, pros guards de
   * exclusão. null se a nota não existir.
   */
  async findOwnershipById(noteId: string): Promise<ContactNoteOwnership | null> {
    const result = await this.pool.query<{
      id: string;
      job_posting_id: string;
      created_by_admin_id: string;
      created_at: string;
    }>(
      `SELECT
         id,
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
      jobPostingId: row.job_posting_id,
      createdByAdminId: row.created_by_admin_id,
      createdAt: row.created_at,
    };
  }

  /** Remove a nota fisicamente. Idempotente (no-op se já não existir). */
  async deleteById(noteId: string): Promise<void> {
    await this.pool.query(`DELETE FROM wja_contact_notes WHERE id = $1`, [noteId]);
  }

  /** Verifica se a vaga existe. Usado como guard antes de operar sobre notas. */
  async validateVacancyExists(vacancyId: string): Promise<boolean> {
    const result = await this.pool.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM job_postings WHERE id = $1) AS exists`,
      [vacancyId],
    );
    return result.rows[0].exists;
  }
}
