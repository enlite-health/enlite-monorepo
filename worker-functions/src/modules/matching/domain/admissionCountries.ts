import { countryToTimezone } from '@shared/locale/CountryTimezone';
import { AR_HOLIDAYS_2026 } from '../infrastructure/AdmissionCalendarService';

/**
 * admissionCountries — per-country configuration for the admission interview
 * scheduling core (multi-country: AR + BR).
 *
 * The scheduling engine (computeFreeSlots) is PURE and country-agnostic: it
 * receives `timezone`, `holidays` and `businessHours` from here rather than
 * hard-coding Argentina. This module is the single source of truth for what
 * differs per country.
 *
 * The admission calendar itself is a DEDICATED Google calendar per country
 * (not the host's primary): the event is created there, impersonating
 * `enlite@enlite.health`, with the interviewer as co-host. The calendar id
 * lives in an env var (`ADMISSION_CALENDAR_ID_AR` / `_BR`) so ops can point it
 * at the real calendar without a redeploy of code.
 */

export type AdmissionCountry = 'AR' | 'BR';

export interface BusinessHours {
  /** First slot starts at this hour (local time). */
  startHour: number;
  /** Slots must END by this hour (local time). */
  endHour: number;
}

export interface AdmissionCountryConfig {
  timezone: string;
  /** National holidays (YYYY-MM-DD in the country's zone) — closed to new slots. */
  holidays: ReadonlySet<string>;
  businessHours: BusinessHours;
  /** Name of the env var holding the dedicated admission calendar id. */
  admissionCalendarIdEnv: string;
}

/**
 * Feriados nacionais BR 2026 (fechados a novos slots). YYYY-MM-DD na zona BR.
 * Lista definida no runbook do App de Pacientes (Task pac-agenda).
 */
export const BR_HOLIDAYS_2026: ReadonlySet<string> = new Set([
  '2026-01-01', // Confraternização Universal
  '2026-02-21', // Carnaval
  '2026-02-22', // Carnaval
  '2026-04-18', // Sexta-feira Santa
  '2026-04-21', // Tiradentes
  '2026-05-01', // Dia do Trabalho
  '2026-06-19', // Corpus Christi
  '2026-09-07', // Independência
  '2026-10-12', // Nossa Senhora Aparecida
  '2026-11-02', // Finados
  '2026-11-15', // Proclamação da República
  '2026-11-20', // Consciência Negra
  '2026-12-25', // Natal
]);

const DEFAULT_BUSINESS_HOURS: BusinessHours = { startHour: 9, endHour: 18 };

export const ADMISSION_COUNTRIES: Record<AdmissionCountry, AdmissionCountryConfig> = {
  AR: {
    timezone: countryToTimezone('AR'), // America/Argentina/Buenos_Aires
    holidays: AR_HOLIDAYS_2026,
    businessHours: DEFAULT_BUSINESS_HOURS,
    admissionCalendarIdEnv: 'ADMISSION_CALENDAR_ID_AR',
  },
  BR: {
    timezone: countryToTimezone('BR'), // America/Sao_Paulo
    holidays: BR_HOLIDAYS_2026,
    businessHours: DEFAULT_BUSINESS_HOURS,
    admissionCalendarIdEnv: 'ADMISSION_CALENDAR_ID_BR',
  },
};

/** Type guard for the public `country` query/body param. */
export function isAdmissionCountry(v: unknown): v is AdmissionCountry {
  return v === 'AR' || v === 'BR';
}

export function getAdmissionCountryConfig(country: AdmissionCountry): AdmissionCountryConfig {
  return ADMISSION_COUNTRIES[country];
}
