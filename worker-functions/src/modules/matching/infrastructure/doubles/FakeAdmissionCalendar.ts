import { randomUUID } from 'crypto';
import type { AdmissionCalendarPort } from '../../application/ports/AdmissionCalendarPort';
import type { BusyInterval, CalendarBusyResult, CreateEventParams } from '../AdmissionCalendarService';

/** Prefixo de e-mail que o dublê trata como "agenda ocupada" (suporta o alternativo "responsável ocupado" do e2e). */
export const FAKE_BUSY_EMAIL_PREFIX = 'ocupado.';
/** Prefixo de e-mail da entrevistadora (`coHostEmail`) que faz o dublê falhar ao criar o evento. */
export const FAKE_CREATE_FAILURE_EMAIL_PREFIX = 'falha.';

/**
 * Dublê do Google Calendar para a stack de teste (`ADMISSION_EXTERNALS=fake`, spec 049 F3). Nada sai da máquina.
 *  - e-mail que começa com `ocupado.` → ocupado em TODA a janela pedida; os demais → livres;
 *  - `createEventWithMeet` devolve `meet.google.com/fak-e049-xxx` e guarda os parâmetros (a unidade confere o `summary`);
 *  - `deleteEvent` só registra;
 *  - `setEventAttendees` só registra em `attendeeUpdates` (spec 052);
 *  - `coHostEmail` que começa com `falha.` → `createEventWithMeet` REJEITA (spec 052: Google falhou, nada pode ficar gravado).
 */
export class FakeAdmissionCalendar implements AdmissionCalendarPort {
  readonly created: CreateEventParams[] = [];
  readonly deleted: { calendarId: string; eventId: string }[] = [];
  readonly attendeeUpdates: { calendarId: string; eventId: string; attendeeEmails: string[] }[] = [];

  async getCalendarTimezone(): Promise<string | null> {
    return null;
  }

  async getBusyIntervals(): Promise<BusyInterval[]> {
    return [];
  }

  async getFreeBusyByCalendar(ids: string[], _impersonate: string, fromISO: string, toISO: string): Promise<CalendarBusyResult[]> {
    return ids.map((calendarId) => ({
      calendarId,
      busy: calendarId.toLowerCase().startsWith(FAKE_BUSY_EMAIL_PREFIX)
        ? [{ start: new Date(fromISO), end: new Date(toISO) }]
        : [],
    }));
  }

  async createEventWithMeet(params: CreateEventParams): Promise<{ eventId: string; meetLink: string }> {
    if (params.coHostEmail?.toLowerCase().startsWith(FAKE_CREATE_FAILURE_EMAIL_PREFIX)) {
      throw new Error('[FakeAdmissionCalendar] falha de criação simulada (coHostEmail com prefixo "falha.")');
    }
    this.created.push(params);
    return { eventId: `fake-evt-${randomUUID()}`, meetLink: `https://meet.google.com/fak-e049-${randomUUID().slice(0, 3)}` };
  }

  async deleteEvent(calendarId: string, eventId: string, _impersonate?: string): Promise<void> {
    this.deleted.push({ calendarId, eventId });
  }

  async setEventAttendees(calendarId: string, eventId: string, _impersonate: string, attendeeEmails: string[]): Promise<void> {
    this.attendeeUpdates.push({ calendarId, eventId, attendeeEmails });
  }
}
