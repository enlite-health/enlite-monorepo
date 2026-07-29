import { DateTime } from 'luxon';
import { v4 as uuidv4 } from 'uuid';
import { getAccessToken } from './GoogleCalendarEventFinder';

// ─── Constants ───────────────────────────────────────────────────────────────

export const AR_ZONE = 'America/Argentina/Buenos_Aires';

/** Feriados nacionais AR 2026 (fechados a novos slots). YYYY-MM-DD em zona AR. */
export const AR_HOLIDAYS_2026: ReadonlySet<string> = new Set([
  '2026-01-01', // Año Nuevo
  '2026-03-24', // Día de la Memoria
  '2026-04-02', // Malvinas
  '2026-05-01', // Día del Trabajador
  '2026-05-25', // Revolución de Mayo
  '2026-06-20', // Belgrano
  '2026-07-09', // Independencia
  '2026-08-17', // San Martín
  '2026-10-12', // Diversidad Cultural
  '2026-11-20', // Soberanía Nacional
  '2026-12-08', // Inmaculada Concepción
  '2026-12-25', // Navidad
]);

// Grade de slots: hora em hora, 09:00–18:00, duração 45min → últimos starts às 17:00.
const BUSINESS_START_HOUR = 9;
const BUSINESS_END_HOUR = 18;
const DEFAULT_SLOT_MINUTES = 45;
const DEFAULT_MIN_LEAD_MINUTES = 120; // now + 2h
const DEFAULT_HORIZON_BUSINESS_DAYS = 10;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BusyInterval {
  start: Date;
  end: Date;
}

export interface FreeSlot {
  startISO: string;
  hostEmails: string[];
}

export interface BusinessHoursConfig {
  /** First slot starts at this hour (local time). */
  startHour: number;
  /** Slots must END by this hour (local time). */
  endHour: number;
}

export interface ComputeFreeSlotsParams {
  /** Busy intervals por host (chaves = e-mails dos hosts a considerar). */
  busyIntervalsByHost: Record<string, BusyInterval[]>;
  /** Instante "agora" (injetável pra teste determinístico). */
  now: Date;
  /** Zona horária do país (default AR). Slots são calculados nesta zona. */
  timezone?: string;
  /** Feriados nacionais (YYYY-MM-DD na zona) fechados a slots (default AR). */
  holidays?: ReadonlySet<string>;
  /** Janela de expediente local (default 09–18). */
  businessHours?: BusinessHoursConfig;
  slotMinutes?: number;
  minLeadMinutes?: number;
  horizonBusinessDays?: number;
}

/**
 * Nova assinatura (multi-país): cria o evento numa AGENDA DEDICADA de admissão
 * (não na primary do host), impersonando `impersonateEmail` (= enlite@enlite.health),
 * com a entrevistadora como co-host.
 */
export interface CreateEventParams {
  /** Agenda de admissão dedicada (ADMISSION_CALENDAR_ID_{country}). */
  calendarId: string;
  /** Quem impersonar via DWD (dono da agenda de admissão, ex. enlite@enlite.health). */
  impersonateEmail: string;
  summary: string;
  description?: string;
  startISO: string;
  endISO: string;
  /** Zona horária do evento (default AR). */
  timezone?: string;
  /** Entrevistadora escolhida — attendee com poder de editar o evento. */
  coHostEmail: string;
  /** E-mail de contato do paciente/lead (attendee), se houver. */
  patientEmail?: string;
}

interface RawCalendarEvent {
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { email?: string; self?: boolean; responseStatus?: string }[];
}

// ─── Pure slot computation (testável, sem I/O) ─────────────────────────────────

/** overlap de [aStart,aEnd) com [bStart,bEnd) */
function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * PURO: gera slots de 45min, hora em hora, seg–sex no expediente (default 09–18),
 * de now+leadMin até +N dias úteis, pulando fim de semana e feriados do país.
 * Um slot entra pra um host se não overlapa nenhum busy dele. Agrega hosts
 * livres por horário (dedupe), ordenado por horário.
 *
 * Multi-país: `timezone`, `holidays` e `businessHours` são parâmetros
 * (default = Argentina), então nada aqui é hardcodado por país.
 */
export function computeFreeSlots(params: ComputeFreeSlotsParams): FreeSlot[] {
  const {
    busyIntervalsByHost,
    now,
    timezone = AR_ZONE,
    holidays = AR_HOLIDAYS_2026,
    businessHours = { startHour: BUSINESS_START_HOUR, endHour: BUSINESS_END_HOUR },
    slotMinutes = DEFAULT_SLOT_MINUTES,
    minLeadMinutes = DEFAULT_MIN_LEAD_MINUTES,
    horizonBusinessDays = DEFAULT_HORIZON_BUSINESS_DAYS,
  } = params;

  const { startHour, endHour } = businessHours;

  const isBusinessDay = (dt: DateTime): boolean => {
    if (dt.weekday > 5) return false; // 6=sáb, 7=dom
    return !holidays.has(dt.toFormat('yyyy-MM-dd'));
  };

  const hostEmails = Object.keys(busyIntervalsByHost);
  const earliestMs = now.getTime() + minLeadMinutes * 60_000;

  // Pré-computa busy em ms por host.
  const busyMsByHost: Record<string, { start: number; end: number }[]> = {};
  for (const host of hostEmails) {
    busyMsByHost[host] = (busyIntervalsByHost[host] ?? []).map((b) => ({
      start: b.start.getTime(),
      end: b.end.getTime(),
    }));
  }

  const slots: FreeSlot[] = [];
  let cursor = DateTime.fromJSDate(now, { zone: timezone }).startOf('day');
  let businessDaysSeen = 0;

  while (businessDaysSeen < horizonBusinessDays) {
    if (isBusinessDay(cursor)) {
      businessDaysSeen += 1;
      for (let hour = startHour; hour < endHour; hour += 1) {
        const slotStart = cursor.set({ hour, minute: 0, second: 0, millisecond: 0 });
        const slotEnd = slotStart.plus({ minutes: slotMinutes });
        // Slot precisa terminar dentro do expediente.
        if (slotEnd.hour > endHour || (slotEnd.hour === endHour && slotEnd.minute > 0)) {
          continue;
        }
        const startMs = slotStart.toMillis();
        const endMs = slotEnd.toMillis();
        if (startMs < earliestMs) continue;

        const freeHosts = hostEmails.filter((host) => {
          const busy = busyMsByHost[host];
          return !busy.some((b) => overlaps(startMs, endMs, b.start, b.end));
        });

        if (freeHosts.length > 0) {
          slots.push({ startISO: slotStart.toISO() as string, hostEmails: freeHosts });
        }
      }
    }
    cursor = cursor.plus({ days: 1 });
  }

  slots.sort((a, b) => a.startISO.localeCompare(b.startISO));
  return slots;
}

// ─── Service (I/O contra Google Calendar) ──────────────────────────────────────

export class AdmissionCalendarService {
  private token(hostEmail: string): Promise<string | null> {
    return getAccessToken(hostEmail, hostEmail);
  }

  /**
   * Busy intervals reais do host via DWD-read events.list na primary.
   * Ignora eventos onde o host tem responseStatus='declined'.
   * Evento all-day = dia inteiro ocupado.
   */
  async getBusyIntervals(
    hostEmail: string,
    fromISO: string,
    toISO: string,
    timezone: string = AR_ZONE,
  ): Promise<BusyInterval[]> {
    const token = await this.token(hostEmail);
    if (!token) throw new Error(`[AdmissionCalendarService] no DWD token for ${hostEmail}`);

    const params = new URLSearchParams({
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '2500',
      timeMin: fromISO,
      timeMax: toISO,
      fields: 'items(start,end,attendees(email,self,responseStatus))',
    });

    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`[AdmissionCalendarService] events.list ${res.status} for ${hostEmail}: ${detail}`);
    }

    const data = (await res.json()) as { items?: RawCalendarEvent[] };
    const intervals: BusyInterval[] = [];

    for (const ev of data.items ?? []) {
      // Host recusou → não conta como ocupado.
      const hostAttendee = (ev.attendees ?? []).find(
        (a) => a.self === true || a.email?.toLowerCase() === hostEmail.toLowerCase(),
      );
      if (hostAttendee?.responseStatus === 'declined') continue;

      if (ev.start?.date && ev.end?.date) {
        // All-day: end.date é exclusivo (dia seguinte). Ocupa [start, end).
        const start = DateTime.fromISO(ev.start.date, { zone: timezone }).startOf('day');
        const end = DateTime.fromISO(ev.end.date, { zone: timezone }).startOf('day');
        if (start.isValid && end.isValid) intervals.push({ start: start.toJSDate(), end: end.toJSDate() });
        continue;
      }

      if (ev.start?.dateTime && ev.end?.dateTime) {
        const start = new Date(ev.start.dateTime);
        const end = new Date(ev.end.dateTime);
        if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
          intervals.push({ start, end });
        }
      }
    }

    return intervals;
  }

  /**
   * Cria evento com Google Meet numa AGENDA DEDICADA de admissão (não na primary
   * do host), impersonando `impersonateEmail` (= enlite@enlite.health), com a
   * entrevistadora como co-host (attendee que pode editar o evento). Attendees =
   * [coHost, patient?]. Retorna id + hangoutLink.
   */
  async createEventWithMeet(
    {
      calendarId,
      impersonateEmail,
      summary,
      description,
      startISO,
      endISO,
      timezone = AR_ZONE,
      coHostEmail,
      patientEmail,
    }: CreateEventParams,
  ): Promise<{ eventId: string; meetLink: string }> {
    const token = await this.token(impersonateEmail);
    if (!token) throw new Error(`[AdmissionCalendarService] no DWD token for ${impersonateEmail}`);

    const attendees = [
      { email: coHostEmail },
      ...(patientEmail ? [{ email: patientEmail }] : []),
    ];

    const body = {
      summary,
      description,
      start: { dateTime: startISO, timeZone: timezone },
      end: { dateTime: endISO, timeZone: timezone },
      attendees,
      // Co-host: a entrevistadora pode editar/remarcar o evento na agenda dedicada.
      guestsCanModify: true,
      conferenceData: {
        createRequest: {
          requestId: uuidv4(),
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      },
    };

    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?conferenceDataVersion=1&sendUpdates=all`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`[AdmissionCalendarService] createEvent ${res.status} on ${calendarId}: ${detail}`);
    }

    const created = (await res.json()) as { id?: string; hangoutLink?: string };
    return { eventId: created.id ?? '', meetLink: created.hangoutLink ?? '' };
  }

  /** Remove evento de uma agenda (limpeza / cancelamento), impersonando o dono. */
  async deleteEvent(calendarId: string, eventId: string, impersonateEmail: string): Promise<void> {
    const token = await this.token(impersonateEmail);
    if (!token) throw new Error(`[AdmissionCalendarService] no DWD token for ${impersonateEmail}`);

    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=all`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
    );
    // 410 = já deletado; tratamos como sucesso idempotente.
    if (!res.ok && res.status !== 410) {
      const detail = await res.text().catch(() => '');
      throw new Error(`[AdmissionCalendarService] deleteEvent ${res.status} on ${calendarId}: ${detail}`);
    }
  }

  /**
   * Conta eventos na primary do host na semana (seg 00:00 – dom 23:59, zona do
   * país) que contém anyDateInWeekISO. Métrica de carga para atribuição.
   */
  async countEventsInWeek(
    hostEmail: string,
    anyDateInWeekISO: string,
    timezone: string = AR_ZONE,
  ): Promise<number> {
    const token = await this.token(hostEmail);
    if (!token) throw new Error(`[AdmissionCalendarService] no DWD token for ${hostEmail}`);

    const ref = DateTime.fromISO(anyDateInWeekISO, { zone: timezone });
    const weekStart = ref.startOf('week'); // luxon: segunda 00:00
    const weekEnd = weekStart.plus({ days: 6 }).endOf('day'); // domingo 23:59:59.999

    const params = new URLSearchParams({
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '2500',
      timeMin: weekStart.toISO() as string,
      timeMax: weekEnd.toISO() as string,
      fields: 'items(id)',
    });

    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`[AdmissionCalendarService] countEventsInWeek ${res.status} for ${hostEmail}: ${detail}`);
    }

    const data = (await res.json()) as { items?: unknown[] };
    return (data.items ?? []).length;
  }
}

export const admissionCalendarService = new AdmissionCalendarService();
