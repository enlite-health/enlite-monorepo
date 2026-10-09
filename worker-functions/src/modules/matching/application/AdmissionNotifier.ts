import { logger } from '@shared/logging';
import type { AdmissionCountry } from '../domain/admissionCountries';

/**
 * AdmissionNotifier — PORT for notifying a booked admission interview.
 *
 * The real delivery (WhatsApp template / Cloud Task) is a LATER phase. Booking
 * only depends on this interface, so the transport can be swapped without
 * touching AdmissionSchedulingService. Ships with a no-op logging impl.
 */
export interface BookedAppointmentNotice {
  appointmentId: string;
  patientId: string;
  country: AdmissionCountry;
  hostEmail: string;
  hostDisplayName: string | null;
  slotStartISO: string;
  slotEndISO: string;
  meetLink: string;
  patientEmail?: string;
}

export interface AdmissionNotifier {
  onBooked(appt: BookedAppointmentNotice): Promise<void>;
}

/** No-op notifier: logs the booking. Real WhatsApp/Cloud Task delivery is another phase. */
export class LoggingAdmissionNotifier implements AdmissionNotifier {
  async onBooked(appt: BookedAppointmentNotice): Promise<void> {
    logger.info(
      {
        appointmentId: appt.appointmentId,
        patientId: appt.patientId,
        country: appt.country,
        slotStartISO: appt.slotStartISO,
        hasMeetLink: Boolean(appt.meetLink),
      },
      'admission.notifier.on_booked',
    );
  }
}
