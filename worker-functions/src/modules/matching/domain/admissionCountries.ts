import { countryToTimezone } from '@shared/locale/CountryTimezone';
import { COUNTRY_CODES, isCountryCode, type CountryCode } from '@shared/domain/countryCodes';
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
 * (not the host's primary): availability IS this calendar (business hours minus
 * whatever is already booked on it — capacity 1, one interview per slot), and
 * the event is created there impersonating `enlite@enlite.health`. There is no
 * per-interviewer roster anymore: the people rotate, the country calendar does
 * not. The calendar id lives in an env var (`ADMISSION_CALENDAR_ID_AR` / `_BR`)
 * so ops can point it at the real calendar without a redeploy of code.
 *
 * The confirmation names the TEAM generically (`teamDisplayName`, e.g.
 * "Equipo de Admisión EnLite"), not an individual — overridable per country via
 * env (`ADMISSION_TEAM_NAME_AR` / `_BR`) without a redeploy.
 */

/**
 * Country codes for admission — DERIVED from the single source
 * `@shared/domain/countryCodes` (D108). The tuple used to be declared literally
 * here AND in `shared/database/requestDbSession.ts`; two identical literals type-
 * check happily until a third jurisdiction lands in one of them only. The public
 * names below are kept verbatim so no caller changes.
 */
export const ADMISSION_COUNTRY_CODES = COUNTRY_CODES;

export type AdmissionCountry = CountryCode;

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
  /**
   * Generic team name shown in the patient confirmation/reminder (no individual
   * interviewer). Default; overridable at runtime via `teamDisplayNameEnv`.
   */
  teamDisplayName: string;
  /** Name of the env var that overrides `teamDisplayName` (optional at runtime). */
  teamDisplayNameEnv: string;
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
    teamDisplayName: 'Equipo de Admisión EnLite',
    teamDisplayNameEnv: 'ADMISSION_TEAM_NAME_AR',
  },
  BR: {
    timezone: countryToTimezone('BR'), // America/Sao_Paulo
    holidays: BR_HOLIDAYS_2026,
    businessHours: DEFAULT_BUSINESS_HOURS,
    admissionCalendarIdEnv: 'ADMISSION_CALENDAR_ID_BR',
    teamDisplayName: 'Equipe de Admissão EnLite',
    teamDisplayNameEnv: 'ADMISSION_TEAM_NAME_BR',
  },
};

/**
 * Resolve the generic team display name for a country: runtime env override
 * (`ADMISSION_TEAM_NAME_{country}`) if set, else the config default.
 */
export function resolveTeamDisplayName(country: AdmissionCountry): string {
  const cfg = ADMISSION_COUNTRIES[country];
  const override = process.env[cfg.teamDisplayNameEnv];
  return override && override.trim() ? override.trim() : cfg.teamDisplayName;
}

/** Type guard for the public `country` query/body param (single source, D108). */
export function isAdmissionCountry(v: unknown): v is AdmissionCountry {
  return isCountryCode(v);
}

export function getAdmissionCountryConfig(country: AdmissionCountry): AdmissionCountryConfig {
  return ADMISSION_COUNTRIES[country];
}
