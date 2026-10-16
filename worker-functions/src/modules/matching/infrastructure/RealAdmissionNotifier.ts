import { Pool } from 'pg';
import { logger } from '@shared/logging';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { AdmissionNotifier, BookedAppointmentNotice } from '../application/AdmissionNotifier';
import type { AdmissionLogger, AdmissionMessagingService } from '../application/AdmissionMessagingService';
import type { AdmissionEventSink, AdmissionReminderTasksPort } from '../application/ports/AdmissionMessagingPorts';
import type { AdmissionMessageContent } from './AdmissionMessageContent';

export { ADMISSION_REMINDER_QUEUE, ADMISSION_REMINDER_URL } from './RealAdmissionReminderTasks';

/** How long before the slot to fire the reminder. */
const REMINDER_LEAD_MS = 30 * 60 * 1000;

/** Nome determinístico da task do lembrete: o Cloud Tasks deduplica por ele (M2). */
export function admissionReminderTaskId(appointmentId: string): string {
  return `admission-reminder-${appointmentId}`;
}

/**
 * RealAdmissionNotifier — the production AdmissionNotifier (usado pelo painel e pelo fluxo do site).
 *
 * onBooked faz duas coisas, independentes (uma falhar nunca trava a outra nem estoura no agendamento):
 *
 *   (a) a confirmação por WhatsApp ao PACIENTE (Twilio Content API direto, sem outbox). O envio passa pelo CLAIM do
 *       `AdmissionMessagingService`: um segundo `onBooked` da mesma reunião perde o claim, grava `duplicate_blocked`
 *       e não envia nem agenda nada (M1). Todo skip (teste, sem consentimento, telefone, template) vira linha.
 *   (b) a task do lembrete 30 min antes, com nome `admission-reminder-<appointmentId>` (M2): a 2ª criação volta
 *       `already_exists` e vira `duplicate_blocked`.
 */
export class RealAdmissionNotifier implements AdmissionNotifier {
  constructor(
    private readonly messaging: AdmissionMessagingService,
    private readonly content: AdmissionMessageContent,
    private readonly reminderTasks: AdmissionReminderTasksPort,
    private readonly events: AdmissionEventSink,
    private readonly db: Pool = DatabaseConnection.getInstance().getPool(),
    private readonly now: () => Date = () => new Date(),
    private readonly log: AdmissionLogger = logger as unknown as AdmissionLogger,
  ) {}

  async onBooked(appt: BookedAppointmentNotice): Promise<void> {
    const facts = {
      appointmentId: appt.appointmentId,
      patientId: appt.patientId,
      country: appt.country,
      hostDisplayName: appt.hostDisplayName,
      slotStart: appt.slotStartISO,
      meetLink: appt.meetLink ?? null,
    };

    let skip: string | undefined;
    try {
      const result = await this.messaging.dispatch({
        appointmentId: appt.appointmentId,
        kind: 'confirmation',
        resolve: () => this.content.resolveWith('confirmation', facts),
      });
      // Perdeu o claim: este onBooked é repetição. Nada de novo a enviar nem a agendar.
      if (result.outcome === 'duplicate_blocked') return;
      skip = result.skip;
    } catch {
      this.log.error({ appointmentId: appt.appointmentId, step: 'confirmation' }, 'admission.confirmation.step_failed');
    }

    // Paciente de teste ou sem consentimento: nem confirmação nem lembrete (as outras causas de skip ainda agendam).
    if (skip === 'skipped_test' || skip === 'skipped_no_consent') return;

    try {
      await this.scheduleReminder(appt);
    } catch {
      this.log.error({ appointmentId: appt.appointmentId, step: 'reminder_schedule' }, 'admission.reminder_schedule.step_failed');
    }
  }

  private async scheduleReminder(appt: BookedAppointmentNotice): Promise<void> {
    const remindAt = new Date(new Date(appt.slotStartISO).getTime() - REMINDER_LEAD_MS);
    if (remindAt.getTime() <= this.now().getTime()) {
      this.log.info({ appointmentId: appt.appointmentId }, 'admission.reminder_skipped.slot_too_soon');
      await this.append(appt.appointmentId, 'skipped_slot_too_soon', 'skipped', 'slot_too_soon', null);
      return;
    }

    const taskId = admissionReminderTaskId(appt.appointmentId);
    const res = await this.reminderTasks.schedule({
      taskId,
      appointmentId: appt.appointmentId,
      runAtISO: remindAt.toISOString(),
    });

    if (res.status === 'already_exists') {
      this.log.warn({ appointmentId: appt.appointmentId, taskId }, 'admission.duplicate_blocked');
      await this.append(appt.appointmentId, 'duplicate_blocked', 'blocked', 'task_already_exists', { step: 'reminder_task', taskId });
      return;
    }
    if (res.status === 'disabled') {
      // Cloud Tasks desligado (local): não há task a registrar.
      this.log.info({ appointmentId: appt.appointmentId }, 'admission.reminder_scheduled.disabled');
      return;
    }

    await this.db.query(
      `UPDATE admission_appointments
          SET reminder_task_name = $2, updated_at = NOW()
        WHERE id = $1`,
      [appt.appointmentId, res.taskName],
    );
    this.log.info({ appointmentId: appt.appointmentId, taskId }, 'admission.reminder_scheduled');
    await this.append(appt.appointmentId, 'reminder_scheduled', 'scheduled', null, { taskName: res.taskName, scheduleTime: remindAt.toISOString() });
  }

  private async append(
    appointmentId: string,
    kind: string,
    outcome: string,
    reason: string | null,
    ref: Record<string, string> | null,
  ): Promise<void> {
    try {
      await this.events.append({ appointmentId, kind, outcome, reason, ref });
    } catch {
      this.log.error({ appointmentId, event: kind }, 'admission.event.append_failed');
    }
  }
}
