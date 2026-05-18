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
