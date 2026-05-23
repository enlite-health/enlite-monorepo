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
  awaiting_reschedule: ['declined', 'pending'],       // pending = REPROGRAM (volta para pool)
  awaiting_reason: ['declined'],
  declined: [],
  no_response: [],
};

/**
 * Valida transições de interview_response em worker_job_applications.
 * Impede transições inválidas (ex: declined → pending).
 *
 * Fluxo de reminder:
 *   confirmed → awaiting_reschedule (worker disse "No" no reminder)
 *   awaiting_reschedule → pending   (worker quer reagendar → REPROGRAM)
 *   awaiting_reschedule → declined  (worker não quer reagendar → envia motivo)
 *   awaiting_reason → declined      (motivo capturado → REJECTED)
 */
export function canTransition(from: string, to: string): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}
