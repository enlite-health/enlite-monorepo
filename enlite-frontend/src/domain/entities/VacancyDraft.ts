/**
 * VacancyDraft
 *
 * Summary of a draft vacancy (is_draft = true — migration 168) created by the
 * app for a patient but not yet published to Talentum. Independent of status:
 * a vacancy already marked as SEARCHING / SEARCHING_REPLACEMENT /
 * RAPID_RESPONSE is still a draft if its publication flow is incomplete.
 */

export interface VacancyDraftSummary {
  id: string;
  case_number: number;
  vacancy_number: number;
  title: string;
  created_at: string;
  updated_at: string;
}

/**
 * Summary of a vacancy that already points to a given patient_address_id
 * (not deleted, not CLOSED). Used by the Step-1 form to warn the operator
 * when selecting an address that already has a vacancy attached — could be
 * a draft (the operator should resume) or a published vacancy (the operator
 * should edit/close the existing one before creating a new vacancy).
 */
export interface VacancyByAddressSummary {
  id: string;
  case_number: number;
  vacancy_number: number;
  title: string;
  status: string;
  is_draft: boolean;
  talentum_published_at: string | null;
  created_at: string;
}
