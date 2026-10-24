import type { TFunction } from 'i18next';
import { weekdayName } from '../substitutionDates';
import { dateLocaleOf, formatWeekDate, weekdayOfDate } from './weekRange';

/** "lun" / "Lun": os 3 primeiros caracteres do nome do dia (o mesmo recorte do cartão do serviço). */
export function shortWeekday(date: string, language: string, capitalize: boolean): string {
  const name = weekdayName(weekdayOfDate(date), language).slice(0, 3);
  return capitalize ? name.charAt(0).toUpperCase() + name.slice(1) : name;
}

/** "09" / "09:30": a hora cheia perde os minutos (o chip do turno é curto: "09–17"). */
const hourOf = (hhmm: string): string => (hhmm.endsWith(':00') ? hhmm.slice(0, 2) : hhmm.slice(0, 5));

/** "Lun 09 · 09–17" — o chip de um turno no passo 2/3 (dia da semana curto, dia do mês, início–fim). */
export function shiftChipLabel(date: string, startTime: string | null, endTime: string | null, language: string): string {
  const day = date.slice(8, 10);
  const hours = startTime && endTime ? ` · ${hourOf(startTime)}–${hourOf(endTime)}` : '';
  return `${shortWeekday(date, language, true)} ${day}${hours}`;
}

/** "lun 9" — o "salvo lun 9: nadie" (sem zero à esquerda, minúsculas). */
export function shortDayLabel(date: string, language: string): string {
  return `${shortWeekday(date, language, false)} ${Number(date.slice(8, 10))}`;
}

/** "3 de noviembre" */
export function dayMonthLabel(date: string, language: string): string {
  return formatWeekDate(date, { day: 'numeric', month: 'long' }, dateLocaleOf(language));
}

/** "Martes 3 de noviembre" — um dia só, com o nome do dia por extenso e a primeira letra maiúscula. */
export function fullDayLabel(date: string, language: string): string {
  const text = `${weekdayName(weekdayOfDate(date), language)} ${dayMonthLabel(date, language)}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * "9 al 20 de noviembre" (mesmo mês) ou "28 de octubre al 3 de noviembre" — as MESMAS chaves do seletor de semana
 * (`weekPicker.rangeSameMonth`/`rangeCrossMonth`): uma formatação de período só na aba.
 */
export function periodRangeLabel(t: TFunction, from: string, to: string, language: string): string {
  const locale = dateLocaleOf(language);
  const key = (k: string, opts: Record<string, unknown>): string => t(`admin.patients.detail.itinerary.weekPicker.${k}`, opts);
  if (from.slice(0, 7) === to.slice(0, 7)) {
    return key('rangeSameMonth', { from: Number(from.slice(8, 10)), to: Number(to.slice(8, 10)), month: formatWeekDate(to, { month: 'long' }, locale) });
  }
  return key('rangeCrossMonth', { from: dayMonthLabel(from, language), to: dayMonthLabel(to, language) });
}

/** `HH:MM` + minutos → `HH:MM` (só aritmética de exibição do FIM de um horário que o banco devolveu como início + duração). */
export function endTimeOf(startTime: string, durationMinutes: number): string {
  const [h, m] = startTime.split(':').map(Number);
  const total = (h * 60 + m + durationMinutes) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
