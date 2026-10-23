import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import { addDaysToDate } from '../substitutionDates';
import { WeekCalendar } from './WeekCalendar';
import { dateLocaleOf, formatWeekDate, weekEndOf, weeksBetween } from './weekRange';

interface WeekPickerProps {
  /** Segunda-feira da semana mostrada. */
  weekStart: string;
  /** Segunda-feira da semana de hoje (`asOf` da API) — o relógio do navegador nunca entra. */
  currentWeekStart: string;
  onChange: (weekStart: string) => void;
  /** O filtro por prestador (N7): fica NA MESMA linha, à direita, antes de "Ir a esta semana" (mockup `b2a.png`). */
  filter?: ReactNode;
}

/**
 * O seletor de semana (spec 069, FR-05; mockup `b2a.png`): UM controle só — pílula `‹ [calendário
 * "2 al 8 de noviembre"] ›`, o texto relativo ("En 2 semanas") e "Ir a esta semana". Substitui as
 * setas soltas e os filtros Inicio/Fin do painel antigo. Sem teto: qualquer semana, à frente ou atrás.
 */
export function WeekPicker({ weekStart, currentWeekStart, onChange, filter }: WeekPickerProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const tw = (key: string, opts?: Record<string, unknown>) => t(`admin.patients.detail.itinerary.weekPicker.${key}`, opts);
  const locale = dateLocaleOf(i18n.language);
  const [open, setOpen] = useState(false);
  const weekEnd = weekEndOf(weekStart);

  const day = (iso: string): string => formatWeekDate(iso, { day: 'numeric' }, locale);
  const dayMonth = (iso: string): string => formatWeekDate(iso, { day: 'numeric', month: 'long' }, locale);
  const month = (iso: string): string => formatWeekDate(iso, { month: 'long' }, locale);
  const rangeLabel =
    weekStart.slice(0, 7) === weekEnd.slice(0, 7)
      ? tw('rangeSameMonth', { from: day(weekStart), to: day(weekEnd), month: month(weekEnd) })
      : tw('rangeCrossMonth', { from: dayMonth(weekStart), to: dayMonth(weekEnd) });

  const offset = weeksBetween(currentWeekStart, weekStart);
  const relative = offset === 0 ? tw('relative.current') : offset === 1 ? tw('relative.next') : offset === -1 ? tw('relative.previous') : offset > 1 ? tw('relative.ahead', { count: offset }) : tw('relative.behind', { count: -offset });

  return (
    <div className="flex flex-wrap items-center gap-4" data-testid="itinerario-semana">
      <div className="relative">
        <div className="flex items-center rounded-full border border-gray-600 bg-white p-1">
          <button
            type="button"
            onClick={() => onChange(addDaysToDate(weekStart, -7))}
            aria-label={tw('previous')}
            data-testid="itinerario-semana-anterior"
            className="flex h-9 w-9 items-center justify-center rounded-full text-primary"
          >
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-haspopup="dialog"
            data-testid="itinerario-semana-abrir"
            data-week-toggle
            className="flex h-9 items-center gap-2 rounded-full bg-purple-100 px-4"
          >
            <CalendarDays size={16} className="text-primary" aria-hidden="true" />
            <Text as="span" size="sm" weight="semibold" color="primary" data-testid="itinerario-semana-rotulo">
              {rangeLabel}
            </Text>
          </button>
          <button
            type="button"
            onClick={() => onChange(addDaysToDate(weekStart, 7))}
            aria-label={tw('next')}
            data-testid="itinerario-semana-seguinte"
            className="flex h-9 w-9 items-center justify-center rounded-full text-primary"
          >
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
        {open && (
          <WeekCalendar
            selectedWeekStart={weekStart}
            currentWeekStart={currentWeekStart}
            onSelectWeek={(w) => {
              onChange(w);
              setOpen(false);
            }}
            onClose={() => setOpen(false)}
          />
        )}
      </div>

      <Text as="span" size="sm" color="tertiary" data-testid="itinerario-semana-relativo">
        {relative}
      </Text>

      <div className="ml-auto flex items-center gap-4">
        {filter}
        <button type="button" onClick={() => onChange(currentWeekStart)} data-testid="itinerario-semana-atual" className="underline whitespace-nowrap">
          <Text as="span" size="sm" weight="semibold" color="primary">
            {tw('goToCurrent')}
          </Text>
        </button>
      </div>
    </div>
  );
}
