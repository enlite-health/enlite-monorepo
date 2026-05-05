/**
 * vacancyCrudHelpers
 *
 * Module-level helpers for VacancyCrudController.
 * Extracted to keep VacancyCrudController within the 400-line limit.
 */

export interface VacancyInsertParams {
  vacancyNumber: number;
  case_number: any;
  computedTitle: string;
  patient_id: any;
  required_professions: any;
  required_sex: any;
  age_range_min: any;
  age_range_max: any;
  worker_profile_sought: any;
  required_experience: any;
  worker_attributes: any;
  schedule: any;
  work_schedule: any;
  providers_needed: any;
  salary_text: any;
  payment_day: any;
  daily_obs: any;
  patient_address_id: any;
  /** Default: 'PENDING_ACTIVATION' when not provided. */
  status?: string;
  /** ISO date (YYYY-MM-DD) or full timestamp. Defaults to NOW() in the SQL when null. */
  published_at?: string | null;
  /** ISO date (YYYY-MM-DD) or full timestamp. Optional — left NULL when not provided. */
  closes_at?: string | null;
}

const CANONICAL_STATUSES = new Set([
  'SEARCHING',
  'SEARCHING_REPLACEMENT',
  'RAPID_RESPONSE',
  'PENDING_ACTIVATION',
  'ACTIVE',
  'SUSPENDED',
  'CLOSED',
]);

export function buildInsertQuery(): string {
  // `published_at` defaults to NOW() when the caller passes NULL — matches the
  // product rule that publication date auto-fills with today if left blank.
  // `closes_at` stays NULL when not provided (optional).
  return `
    INSERT INTO job_postings (
      vacancy_number, case_number, title, description, patient_id,
      required_professions, required_sex,
      age_range_min, age_range_max,
      worker_profile_sought, required_experience, worker_attributes,
      schedule, work_schedule,
      providers_needed, salary_text, payment_day,
      daily_obs,
      patient_address_id,
      status,
      published_at, closes_at,
      country
    ) VALUES (
      $1, $2, $3, '', $4,
      $5, $6,
      $7, $8,
      $9, $10, $11,
      $12, $13,
      $14, $15, $16,
      $17,
      $18,
      $19,
      COALESCE($20::timestamptz, NOW()), $21::timestamptz,
      'AR'
    )
    RETURNING *
  `;
}

export function buildInsertParams(p: VacancyInsertParams): unknown[] {
  const status =
    p.status && CANONICAL_STATUSES.has(p.status) ? p.status : 'PENDING_ACTIVATION';

  return [
    p.vacancyNumber,
    p.case_number,
    p.computedTitle,
    p.patient_id,
    p.required_professions ?? [],
    p.required_sex ?? null,
    p.age_range_min ?? null,
    p.age_range_max ?? null,
    p.worker_profile_sought ?? null,
    p.required_experience ?? null,
    p.worker_attributes ?? null,
    p.schedule ? JSON.stringify(p.schedule) : null,
    p.work_schedule ?? null,
    p.providers_needed,
    p.salary_text ?? 'A convenir',
    p.payment_day ?? null,
    p.daily_obs ?? null,
    p.patient_address_id ?? null,
    status,
    p.published_at ?? null,
    p.closes_at ?? null,
  ];
}
