import { Pool } from 'pg';
import { Result } from '@shared/utils/Result';
import { canTransition } from '../domain/InterviewStateMachine';
import { PubSubClient } from '@shared/events/PubSubClient';
import { GoogleCalendarService } from '@modules/matching';
import { HandleReminderResponseQueries, PendingApplication } from './HandleReminderResponseQueries';

/**
 * HandleReminderResponseUseCase — Step 8 do roadmap.
 *
 * Processa respostas do worker ao fluxo de reminder (24h antes):
 *
 *   confirm_yes     → RSVP accepted no Calendar (check verde)
 *   confirm_no      → pergunta se quer reagendar (awaiting_reschedule)
 *   reschedule_yes  → marca REPROGRAM, remove do Calendar
 *   reschedule_no   → pergunta motivo (awaiting_reason)
 *   texto livre     → captura motivo, marca REJECTED, remove do Calendar
 *
 * Usa InterviewStateMachine para validar transições.
 * Query helpers herdados de HandleReminderResponseQueries (split por validate:lines).
 */
export class HandleReminderResponseUseCase extends HandleReminderResponseQueries {
  constructor(
    db: Pool,
    private readonly pubsub: PubSubClient,
    private readonly googleCalendarService: GoogleCalendarService,
  ) {
    super(db);
  }

  async execute(fromPhone: string, buttonPayload: string, originalMessageSid?: string): Promise<Result<void>> {
    const phone = this.normalizePhone(fromPhone);
    const worker = await this.findWorker(phone);
    if (!worker) return Result.fail('Worker not found');

    const jobPostingId = await this.resolveJobPostingId(originalMessageSid);
    const application = await this.findApplication(worker.id, jobPostingId);
    if (!application) return Result.fail('No pending interview');

    if (buttonPayload === 'confirm_yes') {
      return this.handleConfirmYes(worker, application);
    }

    if (buttonPayload === 'confirm_no') {
      return this.handleConfirmNo(worker, application);
    }

    if (buttonPayload === 'reschedule_yes') {
      return this.handleRescheduleYes(worker, application);
    }

    if (buttonPayload === 'reschedule_no') {
      return this.handleRescheduleNo(worker, application);
    }

    return Result.fail('Unknown button payload');
  }

  /**
   * Processa texto livre do worker como motivo de recusa (REJECTED).
   * Chamado quando worker está em estado awaiting_reason.
   */
  async executeTextResponse(fromPhone: string, bodyText: string): Promise<Result<void>> {
    const phone = this.normalizePhone(fromPhone);
    const worker = await this.findWorker(phone);
    if (!worker) return Result.fail('Worker not found');

    const application = await this.findAwaitingReasonApplication(worker.id);
    if (!application) return Result.fail('No application awaiting reason');

    return this.handleDeclineWithReason(worker, application, bodyText);
  }

  // ─── Handlers ───────────────────────────────────────────────────────────────

  /**
   * confirm_yes: Worker confirma que vai participar.
   * → RSVP accepted no Google Calendar (check verde)
   */
  private async handleConfirmYes(
    worker: { id: string; email: string | null },
    application: PendingApplication,
  ): Promise<Result<void>> {
    if (!canTransition(application.interview_response, 'confirmed')) {
      return Result.fail('Invalid transition');
    }

    await this.db.query(
      `UPDATE worker_job_applications
       SET interview_response    = 'confirmed',
           interview_responded_at = NOW(),
           updated_at             = NOW()
       WHERE worker_id = $1 AND job_posting_id = $2`,
      [worker.id, application.job_posting_id],
    );

    // Google Calendar: marcar RSVP como accepted (check verde)
    if (application.interview_meet_link && worker.email) {
      const calResult = await this.googleCalendarService.confirmAttendee(
        application.interview_meet_link,
        worker.email,
        application.interview_datetime ?? undefined,
      );
      if (calResult.success) {
        console.log(`[HandleReminderResponse] Calendar RSVP confirmed for ${worker.email}`);
      } else {
        console.warn(
          `[HandleReminderResponse] Failed to confirm RSVP for ${worker.email}: ${calResult.reason}`,
        );
      }
    }

    console.log(`[HandleReminderResponse] Worker ${worker.id} confirmed interview for job ${application.job_posting_id}`);
    return Result.ok();
  }

  /**
   * confirm_no: Worker diz que NÃO vai participar.
   * → Pergunta se quer reagendar (template qualified_reminder_reschedule)
   * → Seta interview_response = 'awaiting_reschedule'
   */
  private async handleConfirmNo(
    worker: { id: string; email: string | null },
    application: PendingApplication,
  ): Promise<Result<void>> {
    if (!canTransition(application.interview_response, 'awaiting_reschedule')) {
      return Result.fail('Invalid transition');
    }

    await this.db.query(
      `UPDATE worker_job_applications
       SET interview_response    = 'awaiting_reschedule',
           interview_responded_at = NOW(),
           updated_at             = NOW()
       WHERE worker_id = $1 AND job_posting_id = $2`,
      [worker.id, application.job_posting_id],
    );

    // Enviar template perguntando se quer reagendar
    const outboxResult = await this.db.query(
      `INSERT INTO messaging_outbox (worker_id, template_slug, variables, status, attempts)
       VALUES ($1, 'qualified_reminder_reschedule', $2::jsonb, 'pending', 0)
       RETURNING id`,
      [
        worker.id,
        JSON.stringify({ job_posting_id: application.job_posting_id }),
      ],
    );

    await this.pubsub.publish('outbox-enqueued', { outboxId: outboxResult.rows[0].id });

    console.log(`[HandleReminderResponse] Worker ${worker.id} said No — asking about reschedule`);
    return Result.ok();
  }

  /**
   * reschedule_yes: Worker quer reagendar.
   * → NÃO mexe no Google Calendar (ele quer voltar)
   * → Marca funnel_stage = REPROGRAM, interview_response = pending
   * → Envia mensagem amigável confirmando reagendamento
   */
  private async handleRescheduleYes(
    worker: { id: string; email: string | null },
    application: PendingApplication,
  ): Promise<Result<void>> {
    if (!canTransition(application.interview_response, 'pending')) {
      return Result.fail('Invalid transition');
    }

    // Liberar slot se existir
    if (application.interview_slot_id) {
      await this.db.query(
        `UPDATE interview_slots
         SET booked_count = GREATEST(booked_count - 1, 0),
             updated_at   = NOW()
         WHERE id = $1`,
        [application.interview_slot_id],
      );
    }

    // Buscar case_number para a mensagem
    const vacancyResult = await this.db.query<{ case_number: number | null }>(
      `SELECT case_number FROM job_postings WHERE id = $1`,
      [application.job_posting_id],
    );
    const caseNumber = vacancyResult.rows[0]?.case_number ?? '';

    // Marcar como REPROGRAM — volta para o pool para nova leva de links
    await this.db.query(
      `UPDATE worker_job_applications
       SET interview_response       = 'pending',
           application_funnel_stage = 'REPROGRAM',
           interview_responded_at   = NOW(),
           interview_meet_link      = NULL,
           interview_datetime       = NULL,
           interview_slot_id        = NULL,
           updated_at               = NOW()
       WHERE worker_id = $1 AND job_posting_id = $2`,
      [worker.id, application.job_posting_id],
    );

    // Enviar mensagem amigável confirmando reagendamento — TD-025: dedup atomic
    const outboxResult = await this.db.query(
      `INSERT INTO messaging_outbox (worker_id, template_slug, variables, status, attempts)
       SELECT $1, 'qualified_reprogram_confirm', $2::jsonb, 'pending', 0
       WHERE NOT EXISTS (
         SELECT 1 FROM messaging_outbox
         WHERE worker_id = $1
           AND template_slug = 'qualified_reprogram_confirm'
           AND status IN ('pending', 'sent')
           AND created_at > NOW() - INTERVAL '5 minutes'
           AND variables->>'job_posting_id' = $3
       )
       RETURNING id`,
      [
        worker.id,
        JSON.stringify({ case_number: String(caseNumber), job_posting_id: application.job_posting_id }),
        application.job_posting_id,
      ],
    );

    if (outboxResult.rows.length === 0) {
      console.log(`[HandleReminderResponse] Dedup hit — confirmação de reagendamento já enfileirada nos últimos 5min para worker ${worker.id} / job ${application.job_posting_id}`);
      return Result.ok();
    }

    await this.pubsub.publish('outbox-enqueued', { outboxId: outboxResult.rows[0].id });

    console.log(
      `[HandleReminderResponse] Worker ${worker.id} wants to reschedule — marked REPROGRAM for job ${application.job_posting_id}`,
    );

    return Result.ok();
  }

  /**
   * reschedule_no: Worker NÃO quer reagendar.
   * → Envia template pedindo motivo (qualified_reminder_reason)
   * → Seta interview_response = 'awaiting_reason'
   */
  private async handleRescheduleNo(
    worker: { id: string; email: string | null },
    application: PendingApplication,
  ): Promise<Result<void>> {
    if (!canTransition(application.interview_response, 'declined')) {
      return Result.fail('Invalid transition');
    }

    await this.db.query(
      `UPDATE worker_job_applications
       SET interview_response    = 'awaiting_reason',
           updated_at            = NOW()
       WHERE worker_id = $1 AND job_posting_id = $2`,
      [worker.id, application.job_posting_id],
    );

    // Enviar template pedindo motivo
    const outboxResult = await this.db.query(
      `INSERT INTO messaging_outbox (worker_id, template_slug, variables, status, attempts)
       VALUES ($1, 'qualified_reminder_reason', $2::jsonb, 'pending', 0)
       RETURNING id`,
      [
        worker.id,
        JSON.stringify({ job_posting_id: application.job_posting_id }),
      ],
    );

    await this.pubsub.publish('outbox-enqueued', { outboxId: outboxResult.rows[0].id });

    console.log(`[HandleReminderResponse] Worker ${worker.id} doesn't want to reschedule — asking reason`);
    return Result.ok();
  }

  /**
   * Texto livre: Worker enviou o motivo da recusa.
   * → Salva motivo, remove do Calendar, marca REJECTED
   */
  private async handleDeclineWithReason(
    worker: { id: string; email: string | null },
    application: PendingApplication,
    reason: string,
  ): Promise<Result<void>> {
    if (!canTransition(application.interview_response, 'declined')) {
      return Result.fail('Invalid transition');
    }

    // Liberar slot se existir
    if (application.interview_slot_id) {
      await this.db.query(
        `UPDATE interview_slots
         SET booked_count = GREATEST(booked_count - 1, 0),
             updated_at   = NOW()
         WHERE id = $1`,
        [application.interview_slot_id],
      );
    }

    // Marcar X no Google Calendar (declined) — mantém registro de que foi convidado
    if (application.interview_meet_link && worker.email) {
      await this.googleCalendarService.declineAttendee(
        application.interview_meet_link,
        worker.email,
        application.interview_datetime ?? undefined,
      );
    }

    // Salvar declínio com motivo → REJECTED
    await this.db.query(
      `UPDATE worker_job_applications
       SET interview_response        = 'declined',
           application_funnel_stage  = 'REJECTED',
           interview_decline_reason  = $3,
           interview_responded_at    = NOW(),
           interview_meet_link       = NULL,
           interview_datetime        = NULL,
           interview_slot_id         = NULL,
           updated_at                = NOW()
       WHERE worker_id = $1 AND job_posting_id = $2`,
      [worker.id, application.job_posting_id, reason.trim().substring(0, 1000)],
    );

    // Enviar agradecimento ao worker (free-form, dentro da session window de 24h)
    const outboxResult = await this.db.query(
      `INSERT INTO messaging_outbox (worker_id, template_slug, variables, status, attempts)
       VALUES ($1, 'qualified_declined_thanks', $2::jsonb, 'pending', 0)
       RETURNING id`,
      [
        worker.id,
        JSON.stringify({ job_posting_id: application.job_posting_id }),
      ],
    );

    await this.pubsub.publish('outbox-enqueued', { outboxId: outboxResult.rows[0].id });

    console.log(
      `[HandleReminderResponse] Worker ${worker.id} declined with reason for job ${application.job_posting_id}: "${reason.trim().substring(0, 100)}"`,
    );

    return Result.ok();
  }
}
