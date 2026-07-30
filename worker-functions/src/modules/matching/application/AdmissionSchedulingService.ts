import { DateTime } from 'luxon';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import {
  AdmissionCalendarService,
  admissionCalendarService,
  BusyInterval,
  computeFreeSlots,
} from '../infrastructure/AdmissionCalendarService';
import {
  ADMISSION_COUNTRIES,
  AdmissionCountry,
  getAdmissionCountryConfig,
  resolveTeamDisplayName,
} from '../domain/admissionCountries';
import {
  AdmissionNotifier,
  LoggingAdmissionNotifier,
} from './AdmissionNotifier';

// ─── Errors ────────────────────────────────────────────────────────────────

/** No free host at the requested slot (busy after re-check, or DB double-book). */
export class SlotTakenError extends Error {
  readonly code = 'SLOT_TAKEN';
  constructor(message = 'Slot no longer available') {
    super(message);
    this.name = 'SlotTakenError';
  }
}

/** Patient not found, or not in the requested country. */
export class PatientNotFoundError extends Error {
  readonly code = 'PATIENT_NOT_FOUND';
  constructor(message = 'Patient not found') {
    super(message);
    this.name = 'PatientNotFoundError';
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PublicSlot {
  startISO: string;
  /** Human label formatted in the country's timezone (no host name). */
  label: string;
}

export interface BookParams {
  patientId: string;
  slotStartISO: string;
  country: AdmissionCountry;
}

export interface BookResult {
  appointmentId: string;
  hostDisplayName: string | null;
  slotStartISO: string;
  meetLink: string;
}

interface PatientRow {
  id: string;
  country: string;
  contact_email_encrypted: string | null;
}

const SLOT_MINUTES = 45;

/**
 * AdmissionSchedulingService — orchestrates the admission interview scheduling
 * core (multi-country AR + BR).
 *
 * Availability is NO LONGER per-interviewer. There is no roster: the people who
 * run interviews rotate, so availability is the COUNTRY'S admission calendar —
 * business hours minus whatever is already booked on it (capacity 1: one
 * interview per slot). The old `interview_hosts` table is orphaned (not queried
 * anymore); see migration 256 which flips the anti-double-book guard from
 * UNIQUE(host_email, slot_start) to UNIQUE(country, slot_start).
 *
 *   getAvailableSlots(country) — reads the country's admission calendar (impersonating
 *   enlite@enlite.health), computes free slots with the country config, returns
 *   times only.
 *
 *   book({ patientId, slotStartISO, country }) — re-checks the admission calendar
 *   at the slot (anti-race), inserts the appointment under UNIQUE(country,
 *   slot_start), creates the Meet event on the DEDICATED admission calendar
 *   (impersonating enlite@enlite.health, NO co-host), and notifies via the
 *   AdmissionNotifier port. The confirmation names the TEAM generically.
 */
export class AdmissionSchedulingService {
  constructor(
    private readonly calendar: AdmissionCalendarService = admissionCalendarService,
    private readonly notifier: AdmissionNotifier = new LoggingAdmissionNotifier(),
    private readonly encryption: KMSEncryptionService = new KMSEncryptionService(),
    private readonly impersonateEmail: string = process.env.ADMISSION_IMPERSONATE_EMAIL ||
      'enlite@enlite.health',
  ) {}

  private resolveCalendarId(country: AdmissionCountry): string {
    const cfg = getAdmissionCountryConfig(country);
    const calendarId = process.env[cfg.admissionCalendarIdEnv];
    if (!calendarId) {
      throw new Error(
        `[AdmissionSchedulingService] missing env ${cfg.admissionCalendarIdEnv} for country ${country}`,
      );
    }
    return calendarId;
  }

  /**
   * Public availability for a country: business hours MINUS whatever is already
   * booked on the country's admission calendar (capacity 1). Returns times +
   * labels only.
   */
  async getAvailableSlots(country: AdmissionCountry, now: Date = new Date()): Promise<PublicSlot[]> {
    const cfg = getAdmissionCountryConfig(country);
    const calendarId = this.resolveCalendarId(country);

    // Read window: from now to a generous horizon (the pure fn trims to N
    // business days + lead time).
    const fromISO = DateTime.fromJSDate(now, { zone: cfg.timezone }).startOf('day').toISO() as string;
    const toISO = DateTime.fromJSDate(now, { zone: cfg.timezone })
      .plus({ days: 21 })
      .endOf('day')
      .toISO() as string;

    const busyIntervals: BusyInterval[] = await this.calendar.getBusyIntervals(
      calendarId,
      this.impersonateEmail,
      fromISO,
      toISO,
      cfg.timezone,
    );

    const slots = computeFreeSlots({
      busyIntervals,
      now,
      timezone: cfg.timezone,
      holidays: cfg.holidays,
      businessHours: cfg.businessHours,
    });

    return slots.map((s) => ({
      startISO: s.startISO,
      label: DateTime.fromISO(s.startISO)
        .setZone(cfg.timezone)
        .setLocale('es')
        .toFormat("cccc d LLL, HH:mm"),
    }));
  }

  /**
   * Books an admission interview: anti-race re-check against the country's
   * admission calendar + UNIQUE(country, slot_start) guard + Meet event on the
   * dedicated calendar + notify. No roster, no assignment — capacity 1 per slot.
   */
  async book(params: BookParams): Promise<BookResult> {
    const { patientId, slotStartISO, country } = params;
    const cfg = getAdmissionCountryConfig(country);
    const calendarId = this.resolveCalendarId(country);
    const teamName = resolveTeamDisplayName(country);

    // 1) Patient exists and belongs to the country.
    const patient = await this.loadPatientForCountry(patientId, country);

    const slotStart = DateTime.fromISO(slotStartISO, { zone: cfg.timezone });
    if (!slotStart.isValid) throw new Error(`Invalid slotStartISO: ${slotStartISO}`);
    const slotEnd = slotStart.plus({ minutes: SLOT_MINUTES });
    const startISO = slotStart.toISO() as string;
    const endISO = slotEnd.toISO() as string;

    // 2) Anti-race (a): fresh read of the admission calendar at the slot range.
    //    If anything already overlaps, the slot is gone.
    if (await this.isAdmissionCalendarBusy(calendarId, startISO, endISO, cfg.timezone)) {
      throw new SlotTakenError();
    }

    // 3) Anti-race (b): reserve our side first under UNIQUE(country, slot_start)
    //    BEFORE creating the calendar event, so two concurrent books can't both
    //    create Meet events. host_email stores the country calendar (no person);
    //    host_display_name is the generic team name.
    let appointmentId: string;
    try {
      appointmentId = await this.insertAppointment({
        patientId,
        country,
        hostEmail: calendarId,
        hostDisplayName: teamName,
        slotStartISO: startISO,
        slotEndISO: endISO,
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new SlotTakenError();
      throw err;
    }

    // 4) Create the Meet event on the dedicated admission calendar (no co-host).
    const patientEmail = await this.decryptPatientEmail(patient);
    const { eventId, meetLink } = await this.calendar.createEventWithMeet({
      calendarId,
      impersonateEmail: this.impersonateEmail,
      summary: `Entrevista de admisión — ${teamName}`,
      description: `Entrevista de admisión Enlite (${country}).`,
      startISO,
      endISO,
      timezone: cfg.timezone,
      patientEmail,
    });

    // 5) Persist calendar refs on the appointment.
    await this.attachCalendarRefs(appointmentId, eventId, meetLink);

    // 6) Notify (port — no-op logging impl for now).
    await this.notifier.onBooked({
      appointmentId,
      patientId,
      country,
      hostEmail: calendarId,
      hostDisplayName: teamName,
      slotStartISO: startISO,
      slotEndISO: endISO,
      meetLink,
      patientEmail,
    });

    return {
      appointmentId,
      hostDisplayName: teamName,
      slotStartISO: startISO,
      meetLink,
    };
  }

  // ─── internals ─────────────────────────────────────────────────────────────

  private async loadPatientForCountry(
    patientId: string,
    country: AdmissionCountry,
  ): Promise<PatientRow> {
    const db = DatabaseConnection.getInstance().getPool();
    const res = await db.query<PatientRow>(
      `SELECT id, country, contact_email_encrypted
         FROM patients
        WHERE id = $1 AND deleted_at IS NULL`,
      [patientId],
    );
    const row = res.rows[0];
    if (!row) throw new PatientNotFoundError();
    if (row.country !== country) {
      throw new PatientNotFoundError(`Patient ${patientId} is not in country ${country}`);
    }
    return row;
  }

  private async decryptPatientEmail(patient: PatientRow): Promise<string | undefined> {
    if (!patient.contact_email_encrypted) return undefined;
    const email = await this.encryption.decrypt(patient.contact_email_encrypted);
    return email.trim() ? email.trim() : undefined;
  }

  /**
   * True if the country's admission calendar has any event overlapping
   * [fromISO, toISO) (capacity 1 — one interview per slot). Fresh live read.
   */
  private async isAdmissionCalendarBusy(
    calendarId: string,
    fromISO: string,
    toISO: string,
    timezone: string,
  ): Promise<boolean> {
    const busy = await this.calendar.getBusyIntervals(
      calendarId,
      this.impersonateEmail,
      fromISO,
      toISO,
      timezone,
    );
    const start = new Date(fromISO).getTime();
    const end = new Date(toISO).getTime();
    return busy.some((b) => start < b.end.getTime() && b.start.getTime() < end);
  }

  private async insertAppointment(input: {
    patientId: string;
    country: AdmissionCountry;
    hostEmail: string;
    hostDisplayName: string | null;
    slotStartISO: string;
    slotEndISO: string;
  }): Promise<string> {
    const db = DatabaseConnection.getInstance().getPool();
    const res = await db.query<{ id: string }>(
      `INSERT INTO admission_appointments
         (patient_id, country, host_email, host_display_name, slot_start, slot_end, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'booked')
       RETURNING id`,
      [
        input.patientId,
        input.country,
        input.hostEmail,
        input.hostDisplayName,
        input.slotStartISO,
        input.slotEndISO,
      ],
    );
    return res.rows[0].id;
  }

  private async attachCalendarRefs(
    appointmentId: string,
    calendarEventId: string,
    meetLink: string,
  ): Promise<void> {
    const db = DatabaseConnection.getInstance().getPool();
    await db.query(
      `UPDATE admission_appointments
          SET calendar_event_id = $2, meet_link = $3, updated_at = NOW()
        WHERE id = $1`,
      [appointmentId, calendarEventId, meetLink],
    );
  }
}

/** Postgres unique_violation. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

export const admissionSchedulingService = new AdmissionSchedulingService();

/** Re-export for callers wiring env-based country configs. */
export { ADMISSION_COUNTRIES };
