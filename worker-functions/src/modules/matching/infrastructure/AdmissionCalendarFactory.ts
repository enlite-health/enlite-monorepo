import { reportError } from '@shared/logging';
import {
  AdmissionCalendarPort,
  AdmissionCalendarService,
  BusyInterval,
  CalendarBusyResult,
  CreateEventParams,
} from './AdmissionCalendarService';
import { FakeAdmissionCalendar } from './FakeAdmissionCalendar';

/** Env que seleciona a agenda de admissão. Valores: `'real'` (ou ausente) | `'fake'`. */
export const ADMISSION_CALENDAR_SOURCE_ENV = 'ADMISSION_CALENDAR_SOURCE';

/**
 * Valor desconhecido: fail-closed, como o `ANACARE_HOURS_SOURCE` — nunca cai para
 * o Google em silêncio. Não pode lançar na importação (derrubaria o boot), então
 * toda chamada rejeita, sem rede.
 */
class UnavailableAdmissionCalendar implements AdmissionCalendarPort {
  constructor(private readonly selected: string) {
    reportError(new Error(`${ADMISSION_CALENDAR_SOURCE_ENV} inválido: '${selected}'`), {
      source: 'createAdmissionCalendar',
    });
  }
  private fail(): Promise<never> {
    return Promise.reject(
      new Error(`[AdmissionCalendar] ${ADMISSION_CALENDAR_SOURCE_ENV} inválido ('${this.selected}'): use 'real' ou 'fake'`),
    );
  }
  getBusyIntervals(): Promise<BusyInterval[]> { return this.fail(); }
  getCalendarTimezone(): Promise<string | null> { return this.fail(); }
  getFreeBusyByCalendar(): Promise<CalendarBusyResult[]> { return this.fail(); }
  createEventWithMeet(_p: CreateEventParams): Promise<{ eventId: string; meetLink: string }> { return this.fail(); }
  deleteEvent(): Promise<void> { return this.fail(); }
}

/** Escolhe a agenda de admissão pela env. Ausente ou `real` = Google, igual a antes. */
export function createAdmissionCalendar(env: NodeJS.ProcessEnv = process.env): AdmissionCalendarPort {
  const selected = env[ADMISSION_CALENDAR_SOURCE_ENV];
  if (selected === undefined || selected === '' || selected === 'real') return new AdmissionCalendarService();
  if (selected === 'fake') return new FakeAdmissionCalendar();
  return new UnavailableAdmissionCalendar(selected);
}

/** Instância do processo, lida da env uma vez. */
export const admissionCalendar: AdmissionCalendarPort = createAdmissionCalendar();
