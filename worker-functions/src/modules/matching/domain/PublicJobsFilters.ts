/**
 * PublicJobsFilters — input to ListActivePublicJobsUseCase and findActivePublic.
 *
 * All fields are optional except `country`, which always has a default ('AR').
 */
export interface PublicJobsFilters {
  /** CHAR(2) uppercase — always present (default 'AR') */
  country: string;
  /** Match exact in patient_addresses.state (ILIKE) */
  state?: string;
  /** Match exact in patient_addresses.city (ILIKE) */
  city?: string;
  /** Partial match in patients.diagnosis (ILIKE '%val%') */
  pathology?: string;
  /** Match exact in job_postings.required_sex */
  worker_sex?: string;
  /** Match inside job_postings.required_professions array */
  worker_type?: string;
  /** Free-text search across title, diagnosis, neighborhood, state, city */
  q?: string;
}
