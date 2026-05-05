/**
 * Domain entities for Vacancies and Encuadres
 */

export type RejectionReasonCategory =
  | 'DISTANCE'
  | 'SCHEDULE_INCOMPATIBLE'
  | 'INSUFFICIENT_EXPERIENCE'
  | 'SALARY_EXPECTATION'
  | 'WORKER_DECLINED'
  | 'OVERQUALIFIED'
  | 'DEPENDENCY_MISMATCH'
  | 'TALENTUM_NOT_QUALIFIED'
  | 'OTHER';

export type JobPostingPriority = 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW';

export interface Encuadre {
  id: string;
  worker_name: string | null;
  worker_phone: string | null;
  interview_date: string | null;
  resultado: string | null;
  attended: boolean | null;
  rejection_reason_category: RejectionReasonCategory | null;
  rejection_reason: string | null;
}

/** DTO returned by the public vacancy endpoint GET /api/vacancies/:id */
export interface PublicVacancyDetail {
  id: string;
  case_number: number | null;
  vacancy_number: number;
  title: string;
  status: string;
  required_professions: string[];
  required_sex: string | null;
  age_range_min: number | null;
  age_range_max: number | null;
  worker_attributes: string | null;
  schedule: Record<string, { start: string; end: string }[]> | null;
  schedule_days_hours: string | null;
  salary_text: string | null;
  talentum_description: string | null;
  talentum_whatsapp_url: string | null;
  patient_zone: string | null;
  country: string | null;
  created_at: string;
}

/** Extended fields for the admin vacancy detail view.
 *  Fields marked optional may not yet be returned by the backend.
 */
export interface AdminVacancyDetail {
  id: string;
  title: string | null;
  status: string;
  case_number: number | null;
  vacancy_number: number | null;
  patient_first_name: string | null;
  patient_last_name: string | null;
  patient_diagnosis: string | null;
  patient_zone: string | null;
  patient_city: string | null;
  patient_neighborhood: string | null;
  required_sex: string | null;
  required_professions: string[] | null;
  age_range_min: number | null;
  age_range_max: number | null;
  worker_attributes: string | null;
  service_type: string | null;
  dependency_level: string | null;
  schedule: Record<string, { start: string; end: string }[]> | null;
  schedule_days_hours: string | null;
  country: string | null;
  city: string | null;
  providers_needed: number | null;
  insurance_verified: boolean | null;
  talentum_description: string | null;
  talentum_project_id: string | null;
  talentum_whatsapp_url: string | null;
  talentum_slug: string | null;
  talentum_published_at: string | null;
  meet_link_1: string | null;
  meet_datetime_1: string | null;
  meet_link_2: string | null;
  meet_datetime_2: string | null;
  meet_link_3: string | null;
  meet_datetime_3: string | null;
  social_short_links: Record<string, string> | null;
  encuadres: Array<Encuadre>;
  publications: Array<{
    channel: string | null;
    published_at: string | null;
    recruiter: string | null;
  }>;
  created_at: string | null;
  closed_at: string | null;
  /** Optional fields not yet returned by backend — render '—' when absent */
  payment_term_days?: number | null;
  net_hourly_rate?: string | null;
  weekly_hours?: number | null;
}
