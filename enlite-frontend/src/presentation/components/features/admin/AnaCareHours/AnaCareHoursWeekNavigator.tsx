/**
 * Navegação semanal do detalhe (spec 037): rótulo da semana, "anterior/próxima" (movem a data
 * selecionada ±7 dias) e seletor de data com `min`/`max` (2026-08-01 até o fim do mês corrente).
 * Nasce separado do `AnaCareHoursDetailPage` (CA-5: ≤ 400 linhas) e para que a Spec 032 (intervalo
 * Desde/Hasta) possa substituí-lo inteiro.
 *
 * O seletor guarda um RASCUNHO do que o operador está digitando: um `<input type="date">` emite
 * valores parciais enquanto se digita o ano (`0002-09-07`, `0020-…`, `0202-…`), e prender cada um
 * ao intervalo reescreveria o campo no meio da digitação. Só uma data DENTRO do intervalo navega.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { Input } from '@presentation/components/atoms/Input';
import type { WeekNavigation } from '@hooks/admin/useWeekNavigation';

/** "1 de septiembre" — es-AR, usado no rótulo "semana de X a Y". */
function formatWeekRangeDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return new Intl.DateTimeFormat('es-AR', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(date);
}

export function AnaCareHoursWeekNavigator({ nav }: { nav: WeekNavigation }): JSX.Element {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(nav.selectedDate);
  useEffect(() => setDraft(nav.selectedDate), [nav.selectedDate]);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Text size="sm" color="muted" data-testid="anacare-hours-week-label">
        {t('admin.anacareHours.detail.weekLabel', { start: formatWeekRangeDate(nav.weekStart), end: formatWeekRangeDate(nav.weekEnd) })}
      </Text>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={!nav.canPrev} onClick={nav.goPrev} data-testid="anacare-hours-week-prev">
          <span className="inline-flex items-center gap-1">
            <ChevronLeft className="w-4 h-4" />
            {t('admin.anacareHours.detail.weekPrev')}
          </span>
        </Button>
        <Button variant="outline" size="sm" disabled={!nav.canNext} onClick={nav.goNext} data-testid="anacare-hours-week-next">
          <span className="inline-flex items-center gap-1">
            {t('admin.anacareHours.detail.weekNext')}
            <ChevronRight className="w-4 h-4" />
          </span>
        </Button>
        <Input
          type="date"
          inputSize="compact"
          className="!w-auto"
          leftIcon={<Calendar className="w-4 h-4 text-gray-600" />}
          value={draft}
          min={nav.minDate}
          max={nav.maxDate}
          onChange={(e) => {
            const value = e.target.value;
            setDraft(value);
            if (value && value >= nav.minDate && value <= nav.maxDate) nav.selectDate(value);
          }}
          aria-label={t('admin.anacareHours.detail.weekPickerAriaLabel')}
          data-testid="anacare-hours-week-datepicker"
        />
      </div>
    </div>
  );
}
