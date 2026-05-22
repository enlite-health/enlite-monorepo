/**
 * ClickUpCaseRepository
 *
 * Consultas de analytics sobre os campos do ClickUp que foram
 * incorporados diretamente em job_postings (migration 035).
 *
 * Os campos diagnosis, zone_neighborhood e city_locality pertencem
 * ao paciente — são acessados via JOIN com a tabela patients.
 */
import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';

export interface JobPostingClickUpView {
  id: string;
  caseNumber: number;
  vacancyNumber: number | null;
  clickupTaskId: string | null;
  title: string | null;
  status: string | null;
  priority: string | null;
  // Patient fields (read via JOIN patients)
  diagnosis: string | null;
  patientZone: string | null;
  patientNeighborhood: string | null;
  // Vacancy fields
  workerProfileSought: string | null;
  scheduleDaysHours: string | null;
  sourceCreatedAt: Date | null;
  sourceUpdatedAt: Date | null;
  dueDate: Date | null;
  searchStartDate: Date | null;
  lastComment: string | null;
  country: string;
}

export interface ZoneCount {
  zone: string | null;
  count: number;
}

const BASE_SELECT = `
  SELECT
    jp.id, jp.case_number, jp.vacancy_number, cs.clickup_task_id, jp.title,
    jp.status, jp.priority,
    jp.worker_profile_sought, jp.schedule_days_hours,
    cs.source_created_at, cs.source_updated_at, jp.due_date,
    jp.search_start_date, cs.last_clickup_comment AS last_comment, jp.country,
    -- Patient location fields via patient_addresses (primary slot)
    p.diagnosis,
    pa.neighborhood      AS patient_zone,
    pa.city              AS patient_neighborhood
  FROM job_postings jp
  LEFT JOIN job_postings_clickup_sync cs ON cs.job_posting_id = jp.id
  LEFT JOIN patients p ON p.id = jp.patient_id
  LEFT JOIN patient_addresses pa ON pa.id = jp.patient_address_id
`;

export class ClickUpCaseRepository {
  private pool: Pool;

  constructor() {
    this.pool = DatabaseConnection.getInstance().getPool();
  }

  /** Retorna todos os casos ativos (SEARCHING / SEARCHING_REPLACEMENT) em job_postings */
  async findActiveCases(country: string = 'AR'): Promise<JobPostingClickUpView[]> {
    const result = await this.pool.query(
      `${BASE_SELECT}
       WHERE jp.country = $1
         AND jp.status IN ('SEARCHING', 'SEARCHING_REPLACEMENT', 'RAPID_RESPONSE')
         AND jp.deleted_at IS NULL
       ORDER BY jp.case_number`,
      [country]
    );
    return result.rows.map(this.mapRow);
  }

  /** Busca um caso pelo case_number — retorna a vacante mais recente */
  async findByCaseNumber(caseNumber: number): Promise<JobPostingClickUpView | null> {
    const result = await this.pool.query(
      `${BASE_SELECT} WHERE jp.case_number = $1 AND jp.deleted_at IS NULL ORDER BY jp.created_at DESC LIMIT 1`,
      [caseNumber]
    );
    return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null;
  }

  /** Distribuição de casos por zona geográfica (lida do paciente) */
  async countByZone(country: string = 'AR'): Promise<ZoneCount[]> {
    const result = await this.pool.query(
      `SELECT pa.neighborhood AS zone, COUNT(*)::int AS count
       FROM job_postings jp
       LEFT JOIN patient_addresses pa ON pa.id = jp.patient_address_id
       WHERE jp.country = $1
         AND jp.deleted_at IS NULL
       GROUP BY pa.neighborhood
       ORDER BY count DESC`,
      [country]
    );
    return result.rows.map(r => ({ zone: r.zone as string | null, count: r.count as number }));
  }

  private mapRow(row: Record<string, unknown>): JobPostingClickUpView {
    return {
      id:                   row.id as string,
      caseNumber:           row.case_number as number,
      vacancyNumber:        row.vacancy_number as number | null,
      clickupTaskId:        row.clickup_task_id as string | null,
      title:                row.title as string | null,
      status:               row.status as string | null,
      priority:             row.priority as string | null,
      diagnosis:            row.diagnosis as string | null,
      patientZone:          row.patient_zone as string | null,
      patientNeighborhood:  row.patient_neighborhood as string | null,
      workerProfileSought:  row.worker_profile_sought as string | null,
      scheduleDaysHours:    row.schedule_days_hours as string | null,
      sourceCreatedAt:      row.source_created_at as Date | null,
      sourceUpdatedAt:      row.source_updated_at as Date | null,
      dueDate:              row.due_date as Date | null,
      searchStartDate:      row.search_start_date as Date | null,
      lastComment:          row.last_comment as string | null,
      country:              row.country as string,
    };
  }
}
