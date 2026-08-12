import { Pool } from 'pg';
import * as functions from 'firebase-functions';
import { CloudTasksClient } from '@shared/events/CloudTasksClient';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import {
  AdmissionNotifier,
  BookedAppointmentNotice,
} from '../application/AdmissionNotifier';
import { getAdmissionCountryConfig } from '../domain/admissionCountries';
import {
  AdmissionWhatsAppSender,
  formatAdmissionDateTime,
  hostLabel,
  langForCountry,
  resolveConfirmationContentSid,
} from './admissionTemplates';

/** Cloud Tasks queue for the 30-min-before admission reminder. */
export const ADMISSION_REMINDER_QUEUE = 'admission-reminders';
/** Endpoint the reminder Cloud Task calls back into. */
export const ADMISSION_REMINDER_URL = '/api/internal/reminders/admission-30min';
/** How long before the slot to fire the reminder. */
const REMINDER_LEAD_MS = 30 * 60 * 1000;

interface PatientContactRow {
  phone_whatsapp: string | null;
  first_name: string | null;
  has_consent: boolean | null;
  is_test: boolean | null;
}

/**
 * RealAdmissionNotifier — the production AdmissionNotifier.
 *
 * onBooked does two things, independently (one failing never blocks the other,
 * and neither ever throws out of the booking flow):
 *
 *   (a) sends the immediate confirmation WhatsApp to the PATIENT, DIRECTLY via
 *       Twilio Content API (no outbox / no opt-out — the patient is not a worker
 *       under the anti-spam machinery). Language + timezone come from the
 *       appointment country (AR=es, BR=pt).
 *
 *   (b) schedules a Cloud Task for 30 minutes before the slot; the task name is
 *       persisted on admission_appointments.reminder_task_name (for eventual
 *       cancellation). If the slot is already <30min away, no task is scheduled.
 */
export class RealAdmissionNotifier implements AdmissionNotifier {
  constructor(
    private readonly whatsapp: AdmissionWhatsAppSender,
    private readonly cloudTasks: CloudTasksClient,
    private readonly db: Pool = DatabaseConnection.getInstance().getPool(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async onBooked(appt: BookedAppointmentNotice): Promise<void> {
    // Synthetic gate (ANTES do consentimento): paciente marcado is_test é do
    // synthetic monitoring, que roda todo dia contra produção. Mandar WhatsApp
    // para ele seria (a) cobrar Twilio por um teste e (b) — pior — arriscar
    // enviar mensagem de verdade se o telefone sintético colidir com um número
    // real. O monitor exercita todo o caminho até aqui e assere ESTE log; a
    // saúde do envio de verdade é medida sobre os pacientes reais.
    const testCheck = await this.loadPatientContact(appt.patientId);
    if (testCheck?.is_test) {
      functions.logger.info('admission.notifier.skipped_test_patient', {
        appointmentId: appt.appointmentId,
        patientId: appt.patientId,
      });
      return;
    }

    // Consent gate: only message patients who explicitly agreed (patients.has_consent,
    // set from the form checkbox / Ley 25.326 / LGPD). No consent → no confirmation,
    // no reminder scheduled. The checkbox is enforced, not decorative.
    const contact = testCheck;
    if (!contact?.has_consent) {
      functions.logger.info('admission.notifier.skipped_no_consent', {
        appointmentId: appt.appointmentId,
        patientId: appt.patientId,
      });
      return;
    }
    await this.safe('confirmation', () => this.sendConfirmation(appt), appt);
    await this.safe('reminder_schedule', () => this.scheduleReminder(appt), appt);
  }

  /** Wraps a side effect so a failure is logged, never thrown into booking. */
  private async safe(
    step: string,
    fn: () => Promise<void>,
    appt: BookedAppointmentNotice,
  ): Promise<void> {
    try {
      await fn();
    } catch (err) {
      functions.logger.error('admission.notifier.step_failed', {
        step,
        appointmentId: appt.appointmentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async sendConfirmation(appt: BookedAppointmentNotice): Promise<void> {
    const contact = await this.loadPatientContact(appt.patientId);
    if (!contact?.phone_whatsapp) {
      functions.logger.warn('admission.notifier.confirmation.no_phone', {
        appointmentId: appt.appointmentId,
        patientId: appt.patientId,
      });
      return;
    }

    const lang = langForCountry(appt.country);
    const contentSid = resolveConfirmationContentSid(lang);
    if (!contentSid) {
      functions.logger.warn('admission.notifier.confirmation.template_not_configured', {
        appointmentId: appt.appointmentId,
        lang,
      });
      return;
    }

    const cfg = getAdmissionCountryConfig(appt.country);
    const { date, time } = formatAdmissionDateTime(appt.slotStartISO, cfg.timezone, lang);

    // Positional contentVariables — must match the {{n}} order in the template.
    const vars: Record<string, string> = {
      '1': contact.first_name?.trim() || '',
      '2': hostLabel(appt.hostDisplayName, lang),
      '3': date,
      '4': time,
      '5': appt.meetLink ?? '',
    };

    const res = await this.whatsapp.sendWithContentSid(contact.phone_whatsapp, contentSid, vars);
    if (res.isFailure) {
      functions.logger.warn('admission.notifier.confirmation.send_failed', {
        appointmentId: appt.appointmentId,
        error: res.error,
      });
      return;
    }
    functions.logger.info('admission.notifier.confirmation.sent', {
      appointmentId: appt.appointmentId,
      externalId: res.getValue().externalId,
    });
  }

  private async scheduleReminder(appt: BookedAppointmentNotice): Promise<void> {
    const slotStartMs = new Date(appt.slotStartISO).getTime();
    const remindAt = new Date(slotStartMs - REMINDER_LEAD_MS);

    if (remindAt.getTime() <= this.now().getTime()) {
      functions.logger.info('admission.notifier.reminder.slot_too_soon', {
        appointmentId: appt.appointmentId,
        slotStartISO: appt.slotStartISO,
      });
      return;
    }

    const taskName = await this.cloudTasks.schedule({
      queue: ADMISSION_REMINDER_QUEUE,
      url: ADMISSION_REMINDER_URL,
      body: { appointmentId: appt.appointmentId },
      scheduleTime: remindAt.toISOString(),
    });

    if (!taskName) {
      // Cloud Tasks disabled (local/test) — schedule() returns null. Nothing to persist.
      return;
    }

    await this.db.query(
      `UPDATE admission_appointments
          SET reminder_task_name = $2, updated_at = NOW()
        WHERE id = $1`,
      [appt.appointmentId, taskName],
    );
    functions.logger.info('admission.notifier.reminder.scheduled', {
      appointmentId: appt.appointmentId,
      taskName,
      scheduleTime: remindAt.toISOString(),
    });
  }

  private async loadPatientContact(patientId: string): Promise<PatientContactRow | null> {
    const res = await this.db.query<PatientContactRow>(
      `SELECT phone_whatsapp, first_name, has_consent, is_test
         FROM patients
        WHERE id = $1 AND deleted_at IS NULL`,
      [patientId],
    );
    return res.rows[0] ?? null;
  }
}
