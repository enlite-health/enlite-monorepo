import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, X } from 'lucide-react';
import { TimeSelect } from '@presentation/components/atoms/TimeSelect/TimeSelect';
import { Text } from '@presentation/components/atoms/Text';
import { shiftMinutes, type ServiceShiftFormValue } from '@domain/scheduleHours';

export type { ServiceShiftFormValue };

interface Props {
  /** Index visual do serviço — só compõe os `data-testid` (plan §7.2). */
  index: number;
  value: ServiceShiftFormValue[];
  onChange: (next: ServiceShiftFormValue[]) => void;
  /** `false` enquanto algum turno tem Fin = Inicio sem "Todo el día" — o formulário bloqueia o Guardar. */
  onValidityChange?: (valid: boolean) => void;
  disabled?: boolean;
}

const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const NEW_SHIFT = { startTime: '09:00', endTime: '17:00' };

const isEqualWithoutAllDay = (sh: ServiceShiftFormValue): boolean => !sh.allDay && sh.startTime === sh.endTime;
const minutesOf = (sh: ServiceShiftFormValue): number | null => (sh.allDay ? 1440 : isEqualWithoutAllDay(sh) ? null : shiftMinutes(sh.startTime, sh.endTime));

/**
 * Editor de turnos do serviço contratado (spec 056, plan §7): por dia, N turnos com Inicio / Fin /
 * "Todo el día". Fin ≤ Inicio atravessa a meia-noite ("12 h (+1)"); Fin = Inicio exige o toggle.
 * Não é o `DayScheduleEditor` (compartilhado com vaga e disponibilidade do prestador, intocado).
 */
export function ServiceShiftEditor({ index, value, onChange, onValidityChange, disabled = false }: Props): JSX.Element {
  const { t } = useTranslation();
  const ts = (k: string, o?: Record<string, unknown>): string => t(`admin.patients.editDrawer.shift.${k}`, o);

  const valid = useMemo(() => value.every((sh) => minutesOf(sh) !== null), [value]);
  useEffect(() => { onValidityChange?.(valid); }, [valid, onValidityChange]);

  const byDay = useMemo(() => {
    const map: ServiceShiftFormValue[][] = [[], [], [], [], [], [], []];
    value.forEach((sh) => map[sh.dayOfWeek]?.push(sh));
    return map;
  }, [value]);

  const patch = (target: ServiceShiftFormValue, change: Partial<ServiceShiftFormValue>): void =>
    onChange(value.map((sh) => (sh === target ? { ...sh, ...change } : sh)));

  return (
    <div className="flex flex-col" data-testid={`svc-shift-editor-${index}`}>
      {DAY_KEYS.map((dayKey, day) => (
        <div key={dayKey} className="flex flex-col gap-1 py-1.5 border-b border-gray-600 last:border-b-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Text as="span" size="base" weight="medium" color={byDay[day].length > 0 ? 'primary' : 'secondary'} className="w-24 shrink-0">
              {t(`workerRegistration.availability.${dayKey}`)}
            </Text>
            <div className="flex flex-col gap-1 flex-1 min-w-0">
              {byDay[day].map((sh, i) => {
                const id = `${index}-${day}-${i}`;
                const minutes = minutesOf(sh);
                const nextDay = !sh.allDay && minutes !== null && sh.endTime < sh.startTime;
                return (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <div className="flex items-center gap-1 px-2 py-0.5 rounded-input font-lexend text-white text-sm bg-primary">
                      <Text as="span" size="xs" color="white">{ts('start')}</Text>
                      <TimeSelect value={sh.startTime} onChange={(e) => patch(sh, { startTime: e.target.value, ...(sh.allDay ? { endTime: e.target.value } : {}) })} disabled={disabled} step={5} data-testid={`svc-shift-start-${id}`} className="bg-transparent font-lexend text-white focus:outline-none text-sm cursor-pointer" />
                      <Text as="span" size="xs" color="white">{ts('end')}</Text>
                      <TimeSelect value={sh.endTime} onChange={(e) => patch(sh, { endTime: e.target.value })} disabled={disabled || sh.allDay} step={5} data-testid={`svc-shift-end-${id}`} className="bg-transparent font-lexend text-white focus:outline-none text-sm cursor-pointer" />
                    </div>
                    <label className="flex items-center gap-1 text-sm">
                      <input type="checkbox" checked={sh.allDay} disabled={disabled} data-testid={`svc-shift-allday-${id}`} onChange={(e) => patch(sh, { allDay: e.target.checked, ...(e.target.checked ? { endTime: sh.startTime } : {}) })} />
                      {ts('allDay')}
                    </label>
                    {minutes !== null && (
                      <Text as="span" size="sm" color="secondary" data-testid={`svc-shift-duration-${id}`}>
                        {ts('hours', { hours: Number((minutes / 60).toFixed(2)) })}{nextDay ? ` ${ts('nextDay')}` : ''}
                      </Text>
                    )}
                    <button type="button" onClick={() => onChange(value.filter((x) => x !== sh))} disabled={disabled} aria-label={ts('remove')} data-testid={`svc-shift-remove-${id}`} className="p-1 text-primary hover:text-red-500 transition-colors disabled:opacity-50">
                      <X className="w-3.5 h-3.5" strokeWidth={2.5} />
                    </button>
                    {isEqualWithoutAllDay(sh) && (
                      <Text as="span" size="xs" className="text-red-600" data-testid={`svc-shift-error-${id}`}>{ts('equalUseAllDay')}</Text>
                    )}
                  </div>
                );
              })}
            </div>
            <button type="button" onClick={() => onChange([...value, { dayOfWeek: day, ...NEW_SHIFT, allDay: false }])} disabled={disabled} aria-label={ts('add')} data-testid={`svc-shift-add-${index}-${day}`} className="p-1.5 rounded-pill bg-primary hover:bg-primary/90 transition-colors disabled:opacity-50 shrink-0">
              <Plus className="w-4 h-4 text-white" strokeWidth={2.5} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
