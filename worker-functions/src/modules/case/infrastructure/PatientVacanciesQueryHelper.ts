import { Pool } from 'pg';

/**
 * PatientVacancyRow — shape returned by GET /api/admin/patients/:id/vacancies.
 *
 * Intentionally lean: only the fields needed for the patient vacancy list.
 * Does NOT include PII or worker-matching data.
 */
export interface PatientVacancyRow {
  id: string;
  caseNumber: number | null;
  vacancyNumber: number | null;
  title: string | null;
  status: string | null;
  isDraft: boolean;
  createdAt: Date;
}

const PATIENT_VACANCIES_SQL = `
  SELECT
    jp.id,
    jp.case_number   AS "caseNumber",
    jp.vacancy_number AS "vacancyNumber",
    jp.title,
    jp.status,
    jp.is_draft      AS "isDraft",
    jp.created_at    AS "createdAt"
  FROM job_postings jp
  WHERE jp.patient_id = $1
    AND jp.deleted_at IS NULL
  ORDER BY jp.created_at DESC
`;

/**
 * Fetches all non-deleted vacancies for a given patient.
 * Extracted as a standalone helper (same pattern as PatientDetailQueryHelper)
 * to keep the controller and PatientQueryRepository within the 400-line limit.
 */
export async function fetchPatientVacancies(
  pool: Pool,
  patientId: string,
): Promise<PatientVacancyRow[]> {
  const result = await pool.query<{
    id: string;
    caseNumber: number | null;
    vacancyNumber: number | null;
    title: string | null;
    status: string | null;
    isDraft: boolean;
    createdAt: Date;
  }>(PATIENT_VACANCIES_SQL, [patientId]);

  return result.rows.map((row) => ({
    id: row.id,
    caseNumber: row.caseNumber != null ? Number(row.caseNumber) : null,
    vacancyNumber: row.vacancyNumber != null ? Number(row.vacancyNumber) : null,
    title: row.title,
    status: row.status,
    isDraft: row.isDraft === true,
    createdAt: row.createdAt,
  }));
}
