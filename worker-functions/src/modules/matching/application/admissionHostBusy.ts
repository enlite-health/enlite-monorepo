import { logger } from '@shared/logging';
import type { BusyInterval } from '../infrastructure/AdmissionCalendarService';
import type { AdmissionCountry } from '../domain/admissionCountries';
import type { AdmissionCalendarPort } from './ports/AdmissionCalendarPort';

/**
 * Ocupação das agendas das responsáveis numa única requisição `freeBusy`, descartando (com log) as que não puderam ser lidas
 * (fail-closed). Extraída de `AdmissionSchedulingService.readHostsBusy` SEM mudar o comportamento, para o evento de enquadre
 * (spec 052) ler a mesma ocupação sem cópia.
 */
export async function readHostsBusy(
  calendar: Pick<AdmissionCalendarPort, 'getFreeBusyByCalendar'>,
  impersonateEmail: string,
  emails: string[],
  fromISO: string,
  toISO: string,
  timezone: string,
  country: AdmissionCountry,
): Promise<Record<string, BusyInterval[]>> {
  const results = await calendar.getFreeBusyByCalendar(emails, impersonateEmail, fromISO, toISO, timezone);

  const byHost: Record<string, BusyInterval[]> = {};
  for (const r of results) {
    if (r.error) {
      logger.error(
        { country, calendarId: r.calendarId, reason: r.error },
        '[admission] agenda de atendente ilegível: fica fora do cálculo (fail-closed)',
      );
      continue;
    }
    byHost[r.calendarId] = r.busy;
  }
  return byHost;
}
