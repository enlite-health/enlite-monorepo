/**
 * VacancyDraft
 *
 * Summary of a vacancy in PENDING_ACTIVATION status (a draft created by the app
 * for a patient but not yet fully configured).
 */

export interface VacancyDraftSummary {
  id: string;
  case_number: number;
  vacancy_number: number;
  title: string;
  created_at: string;
  updated_at: string;
}
