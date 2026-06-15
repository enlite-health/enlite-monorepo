import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { ContactNote, CreateContactNoteInput } from '../domain/ContactNote';

/**
 * ContactNoteRepository
 *
 * Persistência append-only de notas de contato por par candidato×vaga (WJA).
 * Tabela: wja_contact_notes (migration 204).
 */
export class ContactNoteRepository {
  private pool: Pool;

  constructor() {
    this.pool = DatabaseConnection.getInstance().getPool();
  }

  async insert(input: CreateContactNoteInput): Promise<ContactNote> {
    const result = await this.pool.query<{
      id: string;
      worker_job_application_id: string;
      note_text: string;
      created_by_admin_id: string;
      created_by_admin_email: string | null;
      created_at: string;
    }>(
      `INSERT INTO wja_contact_notes
         (worker_job_application_id, note_text, created_by_admin_id, created_by_admin_email)
       VALUES ($1, $2, $3, $4)
       RETURNING
         id,
         worker_job_application_id,
         note_text,
         created_by_admin_id,
         created_by_admin_email,
         created_at::text AS created_at`,
      [
        input.workerJobApplicationId,
        input.noteText,
        input.createdByAdminId,
        input.createdByAdminEmail ?? null,
      ],
    );

    const row = result.rows[0];
    return {
      id: row.id,
      workerJobApplicationId: row.worker_job_application_id,
      noteText: row.note_text,
      createdByAdminId: row.created_by_admin_id,
      createdByAdminEmail: row.created_by_admin_email ?? null,
      createdAt: row.created_at,
    };
  }

  async findByWJA(wjaId: string): Promise<ContactNote[]> {
    const result = await this.pool.query<{
      id: string;
      worker_job_application_id: string;
      note_text: string;
      created_by_admin_id: string;
      created_by_admin_email: string | null;
      created_at: string;
    }>(
      `SELECT
         id,
         worker_job_application_id,
         note_text,
         created_by_admin_id,
         created_by_admin_email,
         created_at::text AS created_at
       FROM wja_contact_notes
       WHERE worker_job_application_id = $1
       ORDER BY created_at DESC`,
      [wjaId],
    );

    return result.rows.map(row => ({
      id: row.id,
      workerJobApplicationId: row.worker_job_application_id,
      noteText: row.note_text,
      createdByAdminId: row.created_by_admin_id,
      createdByAdminEmail: row.created_by_admin_email ?? null,
      createdAt: row.created_at,
    }));
  }

  /**
   * Verifica se a WJA pertence à vacante informada.
   * Usado como guard de pertencimento antes de operar sobre notas.
   */
  async wjaBelongsToVacancy(wjaId: string, vacancyId: string): Promise<boolean> {
    const result = await this.pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM worker_job_applications
         WHERE id = $1 AND job_posting_id = $2
       ) AS exists`,
      [wjaId, vacancyId],
    );
    return result.rows[0].exists;
  }
}
