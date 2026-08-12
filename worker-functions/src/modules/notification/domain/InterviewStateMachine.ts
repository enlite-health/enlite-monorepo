export type InterviewResponse =
  | 'pending'
  | 'confirmed'
  | 'declined'
  | 'awaiting_reschedule'
  | 'awaiting_reason'
  | 'no_response';

const VALID_TRANSITIONS: Record<string, string[]> = {
  pending: ['confirmed', 'declined'],
  confirmed: ['confirmed', 'declined', 'awaiting_reschedule'],
  // awaiting_reschedule → awaiting_reschedule: self-loop idempotente (F7.b)
  // Worker que clica reschedule_yes múltiplas vezes permanece no mesmo estado.
  // funnel_stage permanece CONFIRMED — distinguidor é interview_meet_link=NULL.
  awaiting_reschedule: ['declined', 'awaiting_reschedule'],
  awaiting_reason: ['declined'],
  declined: [],
  no_response: [],
};

/**
 * Valida transições de interview_response em worker_job_applications.
 * Impede transições inválidas (ex: declined → pending).
 *
 * Fluxo de reminder (F7.b — ADR-003):
 *   confirmed → awaiting_reschedule (worker disse "No" no reminder)
 *   awaiting_reschedule → awaiting_reschedule (reschedule_yes: idempotente, self-loop)
 *   awaiting_reschedule → declined  (worker não quer reagendar → envia motivo)
 *   awaiting_reason → declined      (motivo capturado → REJECTED)
 */
export function canTransition(from: string, to: string): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}
