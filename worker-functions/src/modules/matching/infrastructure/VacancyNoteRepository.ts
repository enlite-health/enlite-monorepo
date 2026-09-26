import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { VacancyNote, VacancyNoteCategory } from '../domain/VacancyNote';

interface VacancyNoteRow {
  id: string;
  job_posting_id: string;
  occurred_at: Date | string;
  category: VacancyNoteCategory;
  contact: string;
  body: string;
  created_by: string;
  created_at: Date | string;
  author_email?: string | null;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapRow(row: VacancyNoteRow): VacancyNote {
  return {
    id: row.id,
    jobPostingId: row.job_posting_id,
    occurredAt: toIso(row.occurred_at),
    category: row.category,
    contact: row.contact,
    body: row.body,
    createdBy: row.created_by,
    authorEmail: row.author_email ?? null,
    createdAt: toIso(row.created_at),
  };
}

export interface InsertVacancyNoteInput {
  jobPostingId: string;
  occurredAt: string;
  category: VacancyNoteCategory;
  contact: string;
  body: string;
  createdBy: string;
}

/**
 * VacancyNoteRepository
 *
 * Persistência da anotação tipo CRM por vacante (migration 474,
 * `job_posting_notes`). Append-only na aplicação: a tabela só concede
 * SELECT/INSERT a app_runtime/app_system (sem UPDATE/DELETE no GRANT).
 * `authorEmail` nunca é gravado — só resolvido na leitura via LEFT JOIN
 * users (molde GetFunnelActivityStatsUseCase.ts:113-117), porque
 * `created_by` é `staff:<uid>` (mesmo formato da trilha do funil).
 */
export class VacancyNoteRepository {
  private pool: Pool;

  constructor() {
    this.pool = DatabaseConnection.getInstance().getPool();
  }

  async vacancyExists(jobPostingId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM job_postings WHERE id = $1 AND deleted_at IS NULL`,
      [jobPostingId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async insert(input: InsertVacancyNoteInput): Promise<VacancyNote> {
    const result = await this.pool.query<VacancyNoteRow>(
      `INSERT INTO job_posting_notes
         (job_posting_id, occurred_at, category, contact, body, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, job_posting_id, occurred_at, category, contact, body, created_by, created_at`,
      [input.jobPostingId, input.occurredAt, input.category, input.contact, input.body, input.createdBy],
    );
    return mapRow(result.rows[0]);
  }

  async listByVacancy(jobPostingId: string): Promise<VacancyNote[]> {
    const result = await this.pool.query<VacancyNoteRow>(
      `SELECT n.id, n.job_posting_id, n.occurred_at, n.category, n.contact, n.body,
              n.created_by, n.created_at, u.email AS author_email
         FROM job_posting_notes n
         LEFT JOIN users u
                ON n.created_by LIKE 'staff:%'
               AND u.firebase_uid = substring(n.created_by from 7)
        WHERE n.job_posting_id = $1
        ORDER BY n.occurred_at DESC, n.created_at DESC`,
      [jobPostingId],
    );
    return result.rows.map(mapRow);
  }
}
