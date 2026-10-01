import { useCallback, useEffect, useRef, useState } from 'react';
import {
  addDaysIso,
  clampSelectedDate,
  initialSelectedDate,
  monthOfDate,
  monthsOfWeek,
  navigableDateRange,
  startOfWeekMonday,
} from '@presentation/components/features/admin/AnaCareHours/selectors';

export interface WeekNavigation {
  selectedDate: string;
  weekStart: string;
  weekEnd: string;
  /** Meses dos 7 dias da semana, dentro do intervalo navegável — são os que o detalhe precisa buscar. */
  months: string[];
  minDate: string;
  maxDate: string;
  canPrev: boolean;
  canNext: boolean;
  selectDate: (dateIso: string) => void;
  goPrev: () => void;
  goNext: () => void;
}

/**
 * Data selecionada do detalhe (spec 037): a semana mostrada é a de segunda a domingo dessa data.
 * Quando a data muda de mês, avisa `onMonthChange` (a página-rota grava `?month` com `replace`).
 * Anti-laço: quando `month` muda DE FORA (link, "voltar" do navegador) para um mês diferente do da
 * data selecionada, a data reinicia; mudança originada aqui não reinicia (a data já está no mês novo).
 */
export function useWeekNavigation(month: string, onMonthChange?: (month: string) => void): WeekNavigation {
  const [selectedDate, setSelectedDate] = useState(() => initialSelectedDate(month));
  const selectedRef = useRef(selectedDate);
  selectedRef.current = selectedDate;
  const { min, max } = navigableDateRange();

  useEffect(() => {
    if (monthOfDate(selectedRef.current) !== month) setSelectedDate(initialSelectedDate(month));
  }, [month]);

  const selectDate = useCallback(
    (dateIso: string) => {
      const next = clampSelectedDate(dateIso);
      setSelectedDate(next);
      if (monthOfDate(next) !== month) onMonthChange?.(monthOfDate(next));
    },
    [month, onMonthChange],
  );

  const weekStart = startOfWeekMonday(selectedDate);
  return {
    selectedDate,
    weekStart,
    weekEnd: addDaysIso(weekStart, 6),
    months: monthsOfWeek(selectedDate),
    minDate: min,
    maxDate: max,
    canPrev: addDaysIso(selectedDate, -7) >= min,
    canNext: addDaysIso(selectedDate, 7) <= max,
    selectDate,
    goPrev: () => selectDate(addDaysIso(selectedDate, -7)),
    goNext: () => selectDate(addDaysIso(selectedDate, 7)),
  };
}
