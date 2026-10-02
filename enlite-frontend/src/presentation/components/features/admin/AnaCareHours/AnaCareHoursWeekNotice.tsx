/**
 * Aviso da semana do detalhe (spec 037): carregando, erro de um mês ou semana realmente vazia.
 * Regra dura: "sin turnos" (`weekEmpty`) só aparece quando TODOS os meses da semana chegaram `ok` e
 * não há turno. Mês em voo = carregando; mês que falhou = erro com "Reintentar" (os dias dos meses
 * `ok` continuam renderizados abaixo pelo chamador, com este aviso de que faltam dias).
 */
import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import type { MonthStatus } from '@hooks/admin/useAnaCareHoursPatient';
import { formatMonthLabel } from './selectors';

interface Props {
  states: Array<{ month: string; status: MonthStatus }>;
  hasShifts: boolean;
  onRetryMonth?: (month: string) => void;
}

export function AnaCareHoursWeekNotice({ states, hasShifts, onRetryMonth }: Props): JSX.Element | null {
  const { t, i18n } = useTranslation();
  if (states.some((s) => s.status.state === 'loading')) {
    return (
      <Text color="muted" data-testid="anacare-hours-week-loading">
        {t('admin.anacareHours.detail.weekLoading')}
      </Text>
    );
  }
  const failed = states.filter((s) => s.status.state === 'error');
  if (failed.length > 0) {
    return (
      <div className="flex flex-col gap-2" data-testid="anacare-hours-week-error">
        {failed.map(({ month, status }) => (
          <div key={month} className="flex flex-wrap items-center gap-3">
            <Text className="!text-red-600">
              {status.error === 'FONTE_NAO_CONFIGURADA'
                ? t('admin.anacareHours.error.sourceNotConfigured')
                : t('admin.anacareHours.detail.weekMonthError', { month: formatMonthLabel(month, i18n.language) })}
            </Text>
            {onRetryMonth && (
              <Button variant="outline" size="sm" onClick={() => onRetryMonth(month)} data-testid={`anacare-hours-week-retry-${month}`}>
                {t('admin.anacareHours.detail.weekRetry')}
              </Button>
            )}
          </div>
        ))}
      </div>
    );
  }
  if (!hasShifts) {
    return (
      <Text color="muted" data-testid="anacare-hours-week-empty">
        {t('admin.anacareHours.detail.weekEmpty')}
      </Text>
    );
  }
  return null;
}
