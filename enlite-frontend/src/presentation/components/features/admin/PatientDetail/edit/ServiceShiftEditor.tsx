import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Plus, X } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import { copyShiftsToDays, type ServiceShiftFormValue } from '@domain/scheduleHours';

import { ShiftTimeRow } from './ShiftTimeRow';
import { ApplyShiftTemplate, DayChips } from './ApplyShiftTemplate';
import { NEW_SHIFT, isEqualWithoutAllDay, minutesOf, DAY_KEYS, chip } from './shiftRowValues';

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

  const [copyFrom, setCopyFrom] = useState<number | null>(null);
  const [targets, setTargets] = useState<number[]>([]);
  const [conflictDays, setConflictDays] = useState<number[]>([]);
  const toggleTarget = (day: number): void => setTargets((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]));
  const applyCopy = (): void => {
    if (copyFrom === null) return;
    const { next, conflictDays: conflicts } = copyShiftsToDays(value, copyFrom, targets);
    onChange(next);
    setConflictDays(conflicts);
    setCopyFrom(null);
    setTargets([]);
  };

  return (
    <div className="flex flex-col" data-testid={`svc-shift-editor-${index}`}>
      <ApplyShiftTemplate index={index} value={value} disabled={disabled} onApply={({ next, conflictDays: conflicts }) => { onChange(next); setConflictDays(conflicts); }} />
      {DAY_KEYS.map((dayKey, day) => (
        <div key={dayKey} className="flex flex-col gap-1 py-1.5 border-b border-gray-600 last:border-b-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Text as="span" size="base" weight="medium" color={byDay[day].length > 0 ? 'primary' : 'secondary'} className="w-24 shrink-0">
              {t(`workerRegistration.availability.${dayKey}`)}
            </Text>
            <div className="flex flex-col gap-1 flex-1 min-w-0">
              {byDay[day].map((sh, i) => {
                const id = `${index}-${day}-${i}`;
                return (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <ShiftTimeRow value={sh} onChange={(change) => patch(sh, change)} disabled={disabled} testIdSuffix={id} />
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
            {byDay[day].length > 0 && (
              <button type="button" onClick={() => { setConflictDays([]); setTargets([]); setCopyFrom(copyFrom === day ? null : day); }} disabled={disabled || !valid} aria-expanded={copyFrom === day} data-testid={`svc-shift-copy-${index}-${day}`} className="flex items-center gap-1 text-xs text-primary hover:underline disabled:opacity-50 shrink-0">
                <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                {t('workerRegistration.availability.copyTo')}
              </button>
            )}
            <button type="button" onClick={() => onChange([...value, { dayOfWeek: day, ...NEW_SHIFT, allDay: false }])} disabled={disabled} aria-label={ts('add')} data-testid={`svc-shift-add-${index}-${day}`} className="p-1.5 rounded-pill bg-primary hover:bg-primary/90 transition-colors disabled:opacity-50 shrink-0">
              <Plus className="w-4 h-4 text-white" strokeWidth={2.5} />
            </button>
          </div>
          {conflictDays.includes(day) && (
            <Text as="span" size="xs" color="secondary" data-testid={`svc-shift-copy-conflict-${index}-${day}`}>
              {t('workerRegistration.availability.copyConflict', { days: t(`workerRegistration.availability.${dayKey}`) })}
            </Text>
          )}
          {copyFrom === day && (
            <div className="flex flex-wrap items-center gap-1.5" data-testid={`svc-shift-copy-panel-${index}-${day}`}>
              <DayChips exclude={day} selected={targets} onToggle={toggleTarget} testId={(_d, k) => `svc-shift-copy-target-${index}-${k}`} />
              <button type="button" onClick={() => setTargets([1, 2, 3, 4, 5].filter((d) => d !== day))} data-testid={`svc-shift-copy-weekdays-${index}`} className={chip(false)}>
                {t('workerRegistration.availability.copyWeekdays')}
              </button>
              <button type="button" onClick={() => setTargets([0, 1, 2, 3, 4, 5, 6].filter((d) => d !== day))} data-testid={`svc-shift-copy-all-${index}`} className={chip(false)}>
                {t('workerRegistration.availability.copyAll')}
              </button>
              <button type="button" onClick={applyCopy} disabled={targets.length === 0} data-testid={`svc-shift-copy-apply-${index}`} className="px-3 py-0.5 rounded-pill bg-primary text-white text-xs disabled:opacity-50">
                {t('workerRegistration.availability.copyApply')}
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
