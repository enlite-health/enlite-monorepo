import type { BillingWindow, DayKey, MonthKey } from './types';

const DAY_MS = 24 * 3600 * 1000;

export function dayToMs(day: DayKey): number {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function msToDay(ms: number): DayKey {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(day: DayKey, n: number): DayKey {
  return msToDay(dayToMs(day) + n * DAY_MS);
}

export function isMonthKey(v: unknown): v is MonthKey {
  return typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
}

export function monthStartOf(month: MonthKey): DayKey {
  return `${month}-01`;
}

export function addMonths(month: MonthKey, n: number): MonthKey {
  const [y, m] = month.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

export function daysInMonth(month: MonthKey): number {
  return (dayToMs(monthStartOf(addMonths(month, 1))) - dayToMs(monthStartOf(month))) / DAY_MS;
}

export const ANOMALY_SERIES_DAYS = 15;

/** Janelas de partição de uma consulta (spec §9.3). `today` = dia UTC de hoje. */
export function buildWindow(month: MonthKey, today: DayKey): BillingWindow {
  return {
    month,
    monthStart: monthStartOf(month),
    monthEndExclusive: monthStartOf(addMonths(month, 1)),
    prevMonthStart: monthStartOf(addMonths(month, -1)),
    sixMonthsStart: monthStartOf(addMonths(month, -5)),
    dailyFrom: addDays(today, -(ANOMALY_SERIES_DAYS - 1)),
    dailyToExclusive: addDays(today, 1),
  };
}
