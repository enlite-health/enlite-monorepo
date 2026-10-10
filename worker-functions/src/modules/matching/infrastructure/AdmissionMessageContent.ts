import type { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { getAdmissionCountryConfig, isAdmissionCountry } from '../domain/admissionCountries';
import type { AdmissionCountry } from '../domain/admissionCountries';
import { admissionRealm, isBlockedFromPaidPath } from '../domain/admissionRealm';
import type { AdmissionMessageKind } from '../application/ports/AdmissionMessagingPorts';
import type { AdmissionMessageResolver, MessageResolution } from '../application/AdmissionMessagingService';
import {
  formatAdmissionDateTime,
  hostLabel,
  langForCountry,
  resolveConfirmationContentSid,
  resolveReminderContentSid,
} from './admissionTemplates';

/** O que se sabe da reunião para montar a mensagem. */
export interface AppointmentFacts {
  appointmentId: string;
  patientId: string;
  country: AdmissionCountry;
  hostDisplayName: string | null;
  slotStart: string | Date;
  meetLink: string | null;
}

interface PatientContactRow {
  phone_whatsapp: string | null;
  first_name: string | null;
  has_consent: boolean | null;
  is_test: boolean | null;
}

interface AppointmentRow {
  patient_id: string;
  country: string;
  host_display_name: string | null;
  slot_start: Date;
  meet_link: string | null;
  status: string;
}

/**
 * AdmissionMessageContent — decide, DEPOIS de ganhar o claim, se a mensagem sai e com que conteúdo.
 * Gates na ordem de sempre: paciente de teste → consentimento → telefone → template. Todo skip volta com o motivo
 * (o `AdmissionMessagingService` o grava como linha). Serve o envio original e o reenvio.
 */
export class AdmissionMessageContent implements AdmissionMessageResolver {
  constructor(private readonly db: Pool = DatabaseConnection.getInstance().getPool()) {}

  async resolve(kind: AdmissionMessageKind, appointmentId: string): Promise<MessageResolution> {
    const appt = await this.loadAppointment(appointmentId);
    if (!appt || appt.status !== 'booked' || !isAdmissionCountry(appt.country)) return { skip: 'cancelled' };
    return this.resolveWith(kind, {
      appointmentId,
      patientId: appt.patient_id,
      country: appt.country,
      hostDisplayName: appt.host_display_name,
      slotStart: appt.slot_start,
      meetLink: appt.meet_link,
    });
  }

  async resolveWith(kind: AdmissionMessageKind, facts: AppointmentFacts): Promise<MessageResolution> {
    const contact = await this.loadPatientContact(facts.patientId);
    // Synthetic gate ANTES do consentimento: paciente is_test é do monitor sintético e roda todo dia contra produção.
    const realm = admissionRealm({ isTest: contact?.is_test === true });
    if (isBlockedFromPaidPath(realm)) return { skip: 'skipped_test' };
    if (!contact?.has_consent) return { skip: 'skipped_no_consent' };
    if (!contact.phone_whatsapp) return { skip: 'skipped_no_phone' };

    const lang = langForCountry(facts.country);
    const contentSid = kind === 'confirmation' ? resolveConfirmationContentSid(lang) : resolveReminderContentSid(lang);
    if (!contentSid) return { skip: 'skipped_no_template' };

    const cfg = getAdmissionCountryConfig(facts.country);
    const { date, time } = formatAdmissionDateTime(facts.slotStart, cfg.timezone, lang);
    // Positional contentVariables — a ordem tem de bater com os {{n}} do template aprovado (ver admissionTemplates.ts).
    const vars: Record<string, string> =
      kind === 'confirmation'
        ? {
            '1': contact.first_name?.trim() || '',
            '2': hostLabel(facts.hostDisplayName, lang),
            '3': date,
            '4': time,
            '5': facts.meetLink ?? '',
          }
        : { '1': hostLabel(facts.hostDisplayName, lang), '2': time, '3': facts.meetLink ?? '' };
    return { send: { to: contact.phone_whatsapp, contentSid, vars, realm } };
  }

  private async loadAppointment(appointmentId: string): Promise<AppointmentRow | null> {
    const res = await this.db.query<AppointmentRow>(
      `SELECT patient_id, country, host_display_name, slot_start, meet_link, status
         FROM admission_appointments WHERE id = $1`,
      [appointmentId],
    );
    return res.rows[0] ?? null;
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
