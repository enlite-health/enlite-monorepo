import type { AdmissionCalendarPort } from '../../application/ports/AdmissionCalendarPort';

/**
 * Dublê do Google Calendar que FALHA de propósito (spec 050, R-17). Substitui o antigo "Calendar real sem credencial → 500":
 * o e2e do roster (`tests/e2e/admission-scheduling-roster.e2e.test.ts`, "agenda inacessível vira 500 genérico") precisa de uma
 * agenda que não responda, e a forma de obtê-la não pode ser instanciar o cliente real (que manda e-mail e, em teste, lança).
 * Toda chamada rejeita; nada sai da máquina. Entra pela fábrica com `ADMISSION_CALENDAR_DOUBLE=unavailable`.
 */
export class UnavailableAdmissionCalendar implements AdmissionCalendarPort {
  private fail(): Promise<never> {
    return Promise.reject(new Error('[UnavailableAdmissionCalendar] agenda inacessível (dublê que falha de propósito)'));
  }

  getCalendarTimezone(): Promise<string | null> {
    return this.fail();
  }

  getBusyIntervals(): Promise<never> {
    return this.fail();
  }

  getFreeBusyByCalendar(): Promise<never> {
    return this.fail();
  }

  createEventWithMeet(): Promise<never> {
    return this.fail();
  }

  deleteEvent(): Promise<void> {
    return this.fail();
  }
}
