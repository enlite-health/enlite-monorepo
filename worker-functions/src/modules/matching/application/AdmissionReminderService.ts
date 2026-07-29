import { Pool } from 'pg';
import * as functions from 'firebase-functions';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { getAdmissionCountryConfig, isAdmissionCountry } from '../domain/admissionCountries';
import {
  AdmissionWhatsAppSender,
  formatAdmissionDateTime,
  hostLabel,
  langForCountry,
  resolveReminderContentSid,
} from '../infrastructure/admissionTemplates';

export interface ReminderResult {
  sent: boolean;
  reason?: string;
}

interface AppointmentReminderRow {
  patient_id: string;
  country: string;
  host_display_name: string | null;
  slot_start: Date;
  meet_link: string | null;
  status: string;
  reminder_30min_sent_at: Date | null;
}

/**
 * AdmissionReminderService — sends the 30-min-before admission reminder.
 *
 * Called by the internal endpoint POST /api/internal/reminders/admission-30min
 * (fired by the Cloud Task scheduled at booking time). Idempotent: it only
 * sends when the appointment is still 'booked' AND reminder_30min_sent_at is
 * NULL, and stamps that column on success — so a Cloud Tasks retry never
 * re-sends.
 */
export class AdmissionReminderService {
  constructor(
    private readonly whatsapp: AdmissionWhatsAppSender,
    private readonly db: Pool = DatabaseConnection.getInstance().getPool(),
  ) {}

  async send30MinReminder(appointmentId: string): Promise<ReminderResult> {
    const appt = await this.loadAppointment(appointmentId);
    if (!appt) {
      functions.logger.warn('admission.reminder.not_found', { appointmentId });
      return { sent: false, reason: 'not_found' };
    }

    if (appt.status !== 'booked') {
      functions.logger.info('admission.reminder.skip_status', {
        appointmentId,
        status: appt.status,
      });
      return { sent: false, reason: `status_${appt.status}` };
    }

    // Idempotency guard — already delivered (Cloud Tasks at-least-once retry).
    if (appt.reminder_30min_sent_at) {
      return { sent: false, reason: 'already_sent' };
    }

    if (!isAdmissionCountry(appt.country)) {
      functions.logger.warn('admission.reminder.bad_country', { appointmentId, country: appt.country });
      return { sent: false, reason: 'bad_country' };
    }

    const phone = await this.loadPatientPhone(appt.patient_id);
    if (!phone) {
      functions.logger.warn('admission.reminder.no_phone', { appointmentId, patientId: appt.patient_id });
      return { sent: false, reason: 'no_phone' };
    }

    const lang = langForCountry(appt.country);
    const contentSid = resolveReminderContentSid(lang);
    if (!contentSid) {
      functions.logger.warn('admission.reminder.template_not_configured', { appointmentId, lang });
      return { sent: false, reason: 'no_template' };
    }

    const cfg = getAdmissionCountryConfig(appt.country);
    const { time } = formatAdmissionDateTime(appt.slot_start, cfg.timezone, lang);

    // Positional contentVariables — {{1}}=host, {{2}}=hora, {{3}}=meetLink.
    const vars: Record<string, string> = {
      '1': hostLabel(appt.host_display_name, lang),
      '2': time,
      '3': appt.meet_link ?? '',
    };

    const res = await this.whatsapp.sendWithContentSid(phone, contentSid, vars);
    if (res.isFailure) {
      functions.logger.warn('admission.reminder.send_failed', { appointmentId, error: res.error });
      return { sent: false, reason: 'send_failed' };
    }

    // Stamp AFTER a successful send so a failure lets a retry try again.
    await this.db.query(
      `UPDATE admission_appointments
          SET reminder_30min_sent_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [appointmentId],
    );
    functions.logger.info('admission.reminder.sent', {
      appointmentId,
      externalId: res.getValue().externalId,
    });
    return { sent: true };
  }

  private async loadAppointment(appointmentId: string): Promise<AppointmentReminderRow | null> {
    const res = await this.db.query<AppointmentReminderRow>(
      `SELECT patient_id, country, host_display_name, slot_start, meet_link,
              status, reminder_30min_sent_at
         FROM admission_appointments
        WHERE id = $1`,
      [appointmentId],
    );
    return res.rows[0] ?? null;
  }

  private async loadPatientPhone(patientId: string): Promise<string | null> {
    const res = await this.db.query<{ phone_whatsapp: string | null }>(
      `SELECT phone_whatsapp
         FROM patients
        WHERE id = $1 AND deleted_at IS NULL`,
      [patientId],
    );
    return res.rows[0]?.phone_whatsapp ?? null;
  }
}
