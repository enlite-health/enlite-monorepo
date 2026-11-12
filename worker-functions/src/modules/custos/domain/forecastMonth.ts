import { addDays, daysInMonth, dayToMs, monthStartOf } from './dates';
import type { DailyTotal, DayKey, Forecast, MonthKey } from './types';

/**
 * Previsão de fechamento do mês (spec 082, DF-6): custo líquido dos dias completos ÷ nº desses dias × dias do mês.
 * - `lastCompleteDay`: o dia mais recente completo (derivado de `dataUntil` pelo chamador); `null` ou antes do mês -> sem dia completo.
 * - Dia completo sem linha conta como dia de custo 0 (entra no divisor).
 * - Sem dia completo, ou sem NENHUMA linha de custo nos dias completos -> `value: null` (nunca 0 inventado).
 */
export function forecastMonth(month: MonthKey, dailyNet: DailyTotal[], lastCompleteDay: DayKey | null): Forecast {
  const total = daysInMonth(month);
  const first = monthStartOf(month);
  if (!lastCompleteDay || lastCompleteDay < first) return { value: null, basis: 'linear', daysCounted: 0 };

  const lastOfMonth = addDays(first, total - 1);
  const through = lastCompleteDay > lastOfMonth ? lastOfMonth : lastCompleteDay;
  const daysCounted = (dayToMs(through) - dayToMs(first)) / (24 * 3600 * 1000) + 1;

  const inRange = dailyNet.filter((d) => d.day >= first && d.day <= through);
  if (inRange.length === 0) return { value: null, basis: 'linear', daysCounted };

  const net = inRange.reduce((s, d) => s + d.value, 0);
  return { value: (net / daysCounted) * total, basis: 'linear', daysCounted };
}
