import { formatCalendarDate } from '@presentation/utils/dateTimeFormat';
import { addDaysToDate } from '../substitutionDates';

/** Dia da semana de uma data `YYYY-MM-DD` (0 = domingo … 6 = sábado), só `Date.UTC` — nunca o fuso do navegador. */
export function weekdayOfDate(dateIso: string): number {
  const [year, month, day] = dateIso.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** A segunda-feira da semana da data (a semana do seletor vai de segunda a domingo: "2 al 8 de noviembre"). */
export function mondayOf(dateIso: string): string {
  const sinceMonday = (weekdayOfDate(dateIso) + 6) % 7;
  return addDaysToDate(dateIso, -sinceMonday);
}

/** O domingo que fecha a semana que começa em `weekStart`. */
export function weekEndOf(weekStart: string): string {
  return addDaysToDate(weekStart, 6);
}

/** Quantas semanas há de `fromWeekStart` até `toWeekStart` (ambas segundas); negativo = no passado. */
export function weeksBetween(fromWeekStart: string, toWeekStart: string): number {
  const ms = (iso: string): number => {
    const [year, month, day] = iso.split('-').map(Number);
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((ms(toWeekStart) - ms(fromWeekStart)) / (7 * 24 * 60 * 60 * 1000));
}

/** Horas do turno a partir de "HH:MM" — fim <= início cruza a meia-noite (o turno pertence ao dia de INÍCIO, FR-13). */
export function shiftHours(startTime: string, endTime: string): { hours: number; endsNextDay: boolean } {
  const minutes = (hhmm: string): number => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  };
  const endsNextDay = minutes(endTime) <= minutes(startTime);
  const total = minutes(endTime) - minutes(startTime) + (endsNextDay ? 24 * 60 : 0);
  return { hours: Number((total / 60).toFixed(2)), endsNextDay };
}

/** Locale das datas por extenso: es-AR é o padrão da casa, pt-BR só quando o idioma ativo é português. */
export function dateLocaleOf(language: string): string {
  return language.startsWith('pt') ? 'pt-BR' : 'es-AR';
}

/** Data de calendário (`YYYY-MM-DD`) por extenso; se a string não for uma data, devolve ela mesma — a tela nunca fica em branco. */
export function formatWeekDate(dateIso: string, options: Intl.DateTimeFormatOptions, locale: string): string {
  return formatCalendarDate(dateIso, options, locale) ?? dateIso;
}
