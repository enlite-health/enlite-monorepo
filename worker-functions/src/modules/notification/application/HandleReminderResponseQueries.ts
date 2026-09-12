import { Pool } from 'pg';
import { maskPhoneForLog } from '@shared/utils/phoneMask';

export interface PendingApplication {
  id: string;
  job_posting_id: string;
  interview_response: string;
  interview_meet_link: string | null;
  interview_datetime: string | null;
  interview_slot_id: string | null;
}

/**
 * HandleReminderResponseQueries — base class with DB query helpers.
 *
 * Extracted from HandleReminderResponseUseCase to keep it under 400 lines.
 * Not intended to be instantiated directly.
 */
export abstract class HandleReminderResponseQueries {
  constructor(protected readonly db: Pool) {}

  protected async findWorker(phone: string): Promise<{ id: string; email: string | null } | null> {
    const result = await this.db.query(
      `SELECT id, email FROM workers WHERE phone = $1 LIMIT 1`,
      [phone],
    );
    if (result.rows.length === 0) {
      console.warn(`[HandleReminderResponse] Worker not found for phone ${maskPhoneForLog(phone)}`);
      return null;
    }
    return result.rows[0] as { id: string; email: string | null };
  }

  protected async resolveJobPostingId(originalMessageSid?: string): Promise<string | null> {
    if (!originalMessageSid) return null;

    const outboxResult = await this.db.query(
      `SELECT variables->>'job_posting_id' AS job_posting_id
       FROM messaging_outbox
       WHERE twilio_sid = $1
       LIMIT 1`,
      [originalMessageSid],
    );
    return outboxResult.rows[0]?.job_posting_id ?? null;
  }

  protected async findApplication(
    workerId: string,
    jobPostingId: string | null,
  ): Promise<PendingApplication | null> {
    const query = jobPostingId
      ? `SELECT id, job_posting_id, interview_response,
                interview_meet_link, interview_datetime, interview_slot_id
         FROM worker_job_applications
         WHERE worker_id = $1 AND job_posting_id = $2
           AND interview_response IN ('confirmed', 'awaiting_reschedule', 'awaiting_reason')
         LIMIT 1`
      : `SELECT id, job_posting_id, interview_response,
                interview_meet_link, interview_datetime, interview_slot_id
         FROM worker_job_applications
         WHERE worker_id = $1
           AND interview_response IN ('confirmed', 'awaiting_reschedule', 'awaiting_reason')
         ORDER BY updated_at DESC
         LIMIT 1`;

    const params = jobPostingId ? [workerId, jobPostingId] : [workerId];
    const result = await this.db.query(query, params);

    if (result.rows.length === 0) {
      console.warn(`[HandleReminderResponse] No pending interview for worker ${workerId}`);
      return null;
    }

    return result.rows[0] as PendingApplication;
  }

  /**
   * Busca application em estado awaiting_reason para captura de texto livre.
   * Usado quando o worker responde com texto ao invés de botão.
   */
  protected async findAwaitingReasonApplication(workerId: string): Promise<PendingApplication | null> {
    const result = await this.db.query(
      `SELECT id, job_posting_id, interview_response,
              interview_meet_link, interview_datetime, interview_slot_id
       FROM worker_job_applications
       WHERE worker_id = $1
         AND interview_response = 'awaiting_reason'
       ORDER BY updated_at DESC
       LIMIT 1`,
      [workerId],
    );

    return result.rows.length > 0 ? (result.rows[0] as PendingApplication) : null;
  }

  protected normalizePhone(from: string): string {
    return from.replace(/^whatsapp:/, '');
  }
}
