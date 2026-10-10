import { Pool } from 'pg';
import { logger } from '@shared/logging';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { isAdmissionCountry } from '../domain/admissionCountries';
import type { AdmissionMessageContent } from '../infrastructure/AdmissionMessageContent';
import type { AdmissionLogger, AdmissionMessagingService } from './AdmissionMessagingService';

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
}

const REASON_BY_SKIP: Record<string, string> = {
  skipped_test: 'test_patient',
  skipped_no_consent: 'no_consent',
  skipped_no_phone: 'no_phone',
  skipped_no_template: 'no_template',
};

/**
 * AdmissionReminderService — sends the 30-min-before admission reminder.
 *
 * Chamado por POST /api/internal/reminders/admission-30min (a Cloud Task agendada na reserva). O Cloud Tasks entrega
 * at-least-once (a fila de prd tem maxAttempts=100): a idempotência NÃO é mais "carimbar depois de enviar" (M3) — é o
 * CLAIM `reminder_30min` do `AdmissionMessagingService`, no banco. Duas entregas concorrentes disputam o mesmo
 * `INSERT … ON CONFLICT DO NOTHING`; só uma envia, a outra grava `duplicate_blocked`.
 */
export class AdmissionReminderService {
  constructor(
    private readonly messaging: AdmissionMessagingService,
    private readonly content: AdmissionMessageContent,
    private readonly db: Pool = DatabaseConnection.getInstance().getPool(),
    private readonly log: AdmissionLogger = logger as unknown as AdmissionLogger,
  ) {}

  async send30MinReminder(appointmentId: string): Promise<ReminderResult> {
    const appt = await this.loadAppointment(appointmentId);
    if (!appt) {
      this.log.warn({ appointmentId }, 'admission.reminder.not_found');
      return { sent: false, reason: 'not_found' };
    }
    if (!isAdmissionCountry(appt.country)) {
      this.log.warn({ appointmentId }, 'admission.reminder.bad_country');
      return { sent: false, reason: 'bad_country' };
    }
    const country = appt.country;

    const result = await this.messaging.dispatch({
      appointmentId,
      kind: 'reminder_30min',
      resolve: async () =>
        appt.status !== 'booked'
          ? { skip: 'cancelled' as const }
          : this.content.resolveWith('reminder_30min', {
              appointmentId,
              patientId: appt.patient_id,
              country,
              hostDisplayName: appt.host_display_name,
              slotStart: appt.slot_start,
              meetLink: appt.meet_link,
            }),
    });

    switch (result.outcome) {
      case 'sent':
        return { sent: true };
      case 'duplicate_blocked':
        return { sent: false, reason: 'already_sent' };
      case 'send_failed':
        return { sent: false, reason: 'send_failed' };
      default:
        return {
          sent: false,
          reason: result.skip === 'cancelled' ? `status_${appt.status}` : REASON_BY_SKIP[result.skip ?? ''] ?? 'skipped',
        };
    }
  }

  private async loadAppointment(appointmentId: string): Promise<AppointmentReminderRow | null> {
    const res = await this.db.query<AppointmentReminderRow>(
      `SELECT patient_id, country, host_display_name, slot_start, meet_link, status
         FROM admission_appointments
        WHERE id = $1`,
      [appointmentId],
    );
    return res.rows[0] ?? null;
  }
}
