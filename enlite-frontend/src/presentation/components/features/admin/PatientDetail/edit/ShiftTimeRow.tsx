import { useTranslation } from 'react-i18next';
import { TimeSelect } from '@presentation/components/atoms/TimeSelect/TimeSelect';
import { Text } from '@presentation/components/atoms/Text';
import { type ServiceShiftFormValue } from '@domain/scheduleHours';
import { minutesOf } from './shiftRowValues';

interface Props {
  value: ServiceShiftFormValue;
  onChange: (change: Partial<ServiceShiftFormValue>) => void;
  disabled?: boolean;
  /** Compõe os `data-testid` (`svc-shift-start-${testIdSuffix}` …). */
  testIdSuffix: string;
}

/** Início · Fin · "Todo el día" · horas (+1) de UM turno — a mesma linha do editor de turnos do serviço e do catálogo de guardias (074). */
export function ShiftTimeRow({ value: sh, onChange, disabled = false, testIdSuffix: id }: Props): JSX.Element {
  const { t } = useTranslation();
  const ts = (k: string, o?: Record<string, unknown>): string => t(`admin.patients.editDrawer.shift.${k}`, o);
  const minutes = minutesOf(sh);
  const nextDay = !sh.allDay && minutes !== null && sh.endTime < sh.startTime;
  return (
    <>
      <div className="flex items-center gap-1 px-2 py-0.5 rounded-input font-lexend text-white text-sm bg-primary">
        <Text as="span" size="xs" color="white">{ts('start')}</Text>
        <TimeSelect value={sh.startTime} onChange={(e) => onChange({ startTime: e.target.value, ...(sh.allDay ? { endTime: e.target.value } : {}) })} disabled={disabled} step={5} data-testid={`svc-shift-start-${id}`} className="bg-transparent font-lexend text-white focus:outline-none text-sm cursor-pointer" />
        <Text as="span" size="xs" color="white">{ts('end')}</Text>
        <TimeSelect value={sh.endTime} onChange={(e) => onChange({ endTime: e.target.value })} disabled={disabled || sh.allDay} step={5} data-testid={`svc-shift-end-${id}`} className="bg-transparent font-lexend text-white focus:outline-none text-sm cursor-pointer" />
      </div>
      <label className="flex items-center gap-1 text-sm">
        <input type="checkbox" checked={sh.allDay} disabled={disabled} data-testid={`svc-shift-allday-${id}`} onChange={(e) => onChange({ allDay: e.target.checked, ...(e.target.checked ? { endTime: sh.startTime } : {}) })} />
        {ts('allDay')}
      </label>
      {minutes !== null && (
        <Text as="span" size="sm" color="secondary" data-testid={`svc-shift-duration-${id}`}>
          {ts('hours', { hours: Number((minutes / 60).toFixed(2)) })}{nextDay ? ` ${ts('nextDay')}` : ''}
        </Text>
      )}
    </>
  );
}
