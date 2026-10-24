import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import { addDaysToDate, weekdayName } from '../substitutionDates';
import { dateLocaleOf, formatWeekDate, mondayOf, weekEndOf } from './weekRange';

interface WeekCalendarProps {
  /** Segunda-feira da semana selecionada — a semana inteira fica destacada. */
  selectedWeekStart: string;
  /** Segunda-feira da semana de hoje (`asOf` da API): o "Ir a esta semana" volta para ela. */
  currentWeekStart: string;
  onSelectWeek: (weekStart: string) => void;
  onClose: () => void;
}

/** Os 42 dias (6 semanas × 7) que cobrem o mês de `monthStart` (`YYYY-MM-01`), começando numa segunda. */
function monthGrid(monthStart: string): string[] {
  const first = mondayOf(monthStart);
  return Array.from({ length: 42 }, (_, i) => addDaysToDate(first, i));
}

/** Primeiro dia do mês `delta` meses depois de `monthStart` (só `Date.UTC`). */
function shiftMonth(monthStart: string, delta: number): string {
  const [year, month] = monthStart.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1 + delta, 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

/**
 * Calendário do seletor de semana (mockup `b2a.png`, "seletor aberto"): mês, grade de segunda a
 * domingo, a semana selecionada inteira destacada (as pontas em círculo cheio) e, embaixo,
 * "Semana del 2 al 8" + "Ir a esta semana". Clicar em QUALQUER dia seleciona a semana dele — a
 * tabela só mostra uma semana por vez (FR-05). Fecha com Esc e com clique fora.
 */
export function WeekCalendar({ selectedWeekStart, currentWeekStart, onSelectWeek, onClose }: WeekCalendarProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const locale = dateLocaleOf(i18n.language);
  const [monthStart, setMonthStart] = useState(`${selectedWeekStart.slice(0, 7)}-01`);
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedEnd = weekEndOf(selectedWeekStart);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    const onPointer = (e: MouseEvent): void => {
      const target = e.target as Element;
      // O próprio botão que abre o calendário cuida do toggle: fechar aqui e reabrir no `click` seguinte o deixaria sempre aberto.
      if (rootRef.current && !rootRef.current.contains(target) && !target.closest('[data-week-toggle]')) onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [onClose]);

  const inSelectedWeek = (date: string): boolean => date >= selectedWeekStart && date <= selectedEnd;
  const dayNumber = (date: string): string => String(Number(date.slice(8, 10)));
  const monthLabel = formatWeekDate(monthStart, { month: 'long', year: 'numeric' }, locale);
  const dayInitials = [1, 2, 3, 4, 5, 6, 0].map((weekday) => weekdayName(weekday, i18n.language).charAt(0).toUpperCase());

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label={t('admin.patients.detail.itinerary.weekPicker.calendarLabel')}
      data-testid="itinerario-semana-calendario"
      className="absolute left-0 top-full z-20 mt-2 w-[320px] rounded-3xl border border-gray-600 bg-white p-4 shadow-large"
    >
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setMonthStart(shiftMonth(monthStart, -1))}
          aria-label={t('admin.patients.detail.itinerary.weekPicker.previousMonth')}
          data-testid="itinerario-semana-mes-anterior"
          className="flex h-9 w-9 items-center justify-center rounded-full border border-gray-600 text-primary"
        >
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
        <Text as="span" weight="semibold" color="primary" data-testid="itinerario-semana-mes">
          {monthLabel}
        </Text>
        <button
          type="button"
          onClick={() => setMonthStart(shiftMonth(monthStart, 1))}
          aria-label={t('admin.patients.detail.itinerary.weekPicker.nextMonth')}
          data-testid="itinerario-semana-mes-seguinte"
          className="flex h-9 w-9 items-center justify-center rounded-full border border-gray-600 text-primary"
        >
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      </div>

      <div className="mt-3 grid grid-cols-7 text-center">
        {dayInitials.map((initial, i) => (
          <Text key={i} as="span" size="xs" weight="semibold" color="primary">
            {initial}
          </Text>
        ))}
      </div>

      <div className="mt-1 grid grid-cols-7 gap-y-1">
        {monthGrid(monthStart).map((date) => {
          const selected = inSelectedWeek(date);
          const edge = date === selectedWeekStart || date === selectedEnd;
          const otherMonth = date.slice(0, 7) !== monthStart.slice(0, 7);
          const shape = edge ? 'rounded-full bg-primary' : '';
          const edgeShape = date === selectedWeekStart ? 'rounded-l-full' : date === selectedEnd ? 'rounded-r-full' : '';
          return (
            <div key={date} className={selected ? `bg-purple-100 ${edgeShape}` : ''}>
              <button
                type="button"
                onClick={() => onSelectWeek(mondayOf(date))}
                aria-pressed={selected}
                aria-label={formatWeekDate(date, { weekday: 'long', day: 'numeric', month: 'long' }, locale)}
                data-testid={`itinerario-semana-dia-${date}`}
                className={`mx-auto flex h-9 w-9 items-center justify-center ${shape}`}
              >
                <Text as="span" size="sm" weight={otherMonth && !selected ? 'normal' : 'semibold'} color={edge ? 'white' : otherMonth && !selected ? 'tertiary' : 'primary'}>
                  {dayNumber(date)}
                </Text>
              </button>
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex items-center justify-between">
        <Text as="span" size="xs" color="tertiary" data-testid="itinerario-semana-calendario-faixa">
          {t('admin.patients.detail.itinerary.weekPicker.weekOf', {
            from: dayNumber(selectedWeekStart),
            to: dayNumber(selectedEnd),
          })}
        </Text>
        <button
          type="button"
          onClick={() => onSelectWeek(currentWeekStart)}
          data-testid="itinerario-semana-calendario-hoje"
          className="underline"
        >
          <Text as="span" size="sm" weight="semibold" color="primary">
            {t('admin.patients.detail.itinerary.weekPicker.goToCurrent')}
          </Text>
        </button>
      </div>
    </div>
  );
}
