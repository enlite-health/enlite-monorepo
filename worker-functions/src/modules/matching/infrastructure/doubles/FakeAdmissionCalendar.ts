import { randomUUID } from 'crypto';
import type { AdmissionCalendarPort } from '../../application/ports/AdmissionCalendarPort';
import type { BusyInterval, CalendarBusyResult, CreateEventParams } from '../AdmissionCalendarService';

/** Prefixo de e-mail que o dublê trata como "agenda ocupada" (suporta o alternativo "responsável ocupado" do e2e). */
export const FAKE_BUSY_EMAIL_PREFIX = 'ocupado.';

/**
 * Dublê do Google Calendar para a stack de teste (`ADMISSION_EXTERNALS=fake`, spec 049 F3). Nada sai da máquina.
 *  - e-mail que começa com `ocupado.` → ocupado em TODA a janela pedida; os demais → livres;
 *  - `createEventWithMeet` devolve `meet.google.com/fak-e049-xxx` e guarda os parâmetros (a unidade confere o `summary`);
 *  - `deleteEvent` só registra.
 */
export class FakeAdmissionCalendar implements AdmissionCalendarPort {
  readonly created: CreateEventParams[] = [];
  readonly deleted: { calendarId: string; eventId: string }[] = [];

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
    this.created.push(params);
    return { eventId: `fake-evt-${randomUUID()}`, meetLink: `https://meet.google.com/fak-e049-${randomUUID().slice(0, 3)}` };
  }

  async deleteEvent(calendarId: string, eventId: string, _impersonate?: string): Promise<void> {
    this.deleted.push({ calendarId, eventId });
  }
}
