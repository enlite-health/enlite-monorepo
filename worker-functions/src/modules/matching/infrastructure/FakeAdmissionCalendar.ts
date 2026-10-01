import { createHash } from 'crypto';
import { logger } from '@shared/logging';
import { ADMISSION_COUNTRIES } from '../domain/admissionCountries';
import type {
  AdmissionCalendarPort,
  BusyInterval,
  CalendarBusyResult,
  CreateEventParams,
} from './AdmissionCalendarService';

const TAG = '[FakeAdmissionCalendar]';

/**
 * Agenda de admissão FALSA (`ADMISSION_CALENDAR_SOURCE=fake`, usada na stage — D458).
 * Nunca toca googleapis/oauth2/iam: toda agenda está livre, o evento criado é só um
 * id determinístico e um link `.invalid` (TLD reservado, não resolve). Os logs
 * não levam e-mail, summary nem id de agenda: só o nome da operação.
 */
export class FakeAdmissionCalendar implements AdmissionCalendarPort {
  async getBusyIntervals(
    _calendarId: string,
    _impersonateEmail: string,
    _fromISO: string,
    _toISO: string,
    _timezone?: string,
  ): Promise<BusyInterval[]> {
    logger.info({ op: 'getBusyIntervals' }, `${TAG} agenda livre`);
    return [];
  }

  /** Fuso do país dono da agenda (lido da env de agenda do país); desconhecida → null (o chamador cai no default). */
  async getCalendarTimezone(calendarId: string, _impersonateEmail: string): Promise<string | null> {
    logger.info({ op: 'getCalendarTimezone' }, `${TAG} fuso do país`);
    const cfg = Object.values(ADMISSION_COUNTRIES).find(
      (c) => process.env[c.admissionCalendarIdEnv] === calendarId,
    );
    return cfg?.timezone ?? null;
  }

  /** Um resultado livre por agenda (sem omitir nenhuma: omitir cairia no fail-closed). */
  async getFreeBusyByCalendar(
    calendarIds: string[],
    _impersonateEmail: string,
    _fromISO: string,
    _toISO: string,
    _timezone?: string,
  ): Promise<CalendarBusyResult[]> {
    const ids = [...new Set(calendarIds)].filter((id) => id.trim() !== '');
    logger.info({ op: 'getFreeBusyByCalendar', agendas: ids.length }, `${TAG} agendas livres`);
    return ids.map((calendarId) => ({ calendarId, busy: [] }));
  }

  async createEventWithMeet(p: CreateEventParams): Promise<{ eventId: string; meetLink: string }> {
    const hash = createHash('sha256').update(`${p.calendarId}|${p.startISO}|${p.endISO}`).digest('hex').slice(0, 16);
    const eventId = `fake-${hash}`;
    logger.info({ op: 'createEventWithMeet', eventId }, `${TAG} evento falso criado`);
    return { eventId, meetLink: `https://meet.invalid/${eventId}` };
  }

  async deleteEvent(_calendarId: string, _eventId: string, _impersonateEmail: string): Promise<void> {
    logger.info({ op: 'deleteEvent' }, `${TAG} remoção ignorada`);
  }
}
