import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Plus, X } from 'lucide-react';
import { TimeSelect } from '@presentation/components/atoms/TimeSelect/TimeSelect';
import { Text } from '@presentation/components/atoms/Text';
import { copySlotsToDays, isValidRange } from './copySlotsToDays';

/**
 * Slot canônico (formato JSONB usado no backend e em worker availability).
 * dayOfWeek: 0 = domingo, 6 = sábado.
 */
export interface DayScheduleSlot {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

interface DayScheduleEditorProps {
  value: DayScheduleSlot[];
  onChange: (next: DayScheduleSlot[]) => void;
  disabled?: boolean;
  /** Override do label do dia (default usa `workerRegistration.availability.<day>`) */
  dayLabelI18nKey?: (dayKey: string) => string;
}

const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const DEFAULT_SLOT = { startTime: '09:00', endTime: '17:00' };

export function DayScheduleEditor({
  value,
  onChange,
  disabled = false,
  dayLabelI18nKey,
}: DayScheduleEditorProps): JSX.Element {
  const { t } = useTranslation();
  const [copyFrom, setCopyFrom] = useState<number | null>(null);
  const [targets, setTargets] = useState<number[]>([]);
  const [conflictDays, setConflictDays] = useState<number[]>([]);

  const slotsByDay = useMemo(() => {
    const map = new Map<number, DayScheduleSlot[]>();
    for (let i = 0; i < 7; i++) map.set(i, []);
    for (const slot of value) {
      const list = map.get(slot.dayOfWeek);
      if (list) list.push(slot);
    }
    return map;
  }, [value]);

  const addSlot = (dayIndex: number): void => {
    onChange([
      ...value,
      { dayOfWeek: dayIndex, startTime: DEFAULT_SLOT.startTime, endTime: DEFAULT_SLOT.endTime },
    ]);
  };

  const removeSlot = (dayIndex: number, slotIndexWithinDay: number): void => {
    let count = -1;
    const next = value.filter((slot) => {
      if (slot.dayOfWeek !== dayIndex) return true;
      count++;
      return count !== slotIndexWithinDay;
    });
    onChange(next);
  };

  const updateSlot = (
    dayIndex: number,
    slotIndexWithinDay: number,
    field: 'startTime' | 'endTime',
    newValue: string,
  ): void => {
    let count = -1;
    const next = value.map((slot) => {
      if (slot.dayOfWeek !== dayIndex) return slot;
      count++;
      if (count !== slotIndexWithinDay) return slot;
      return { ...slot, [field]: newValue };
    });
    onChange(next);
  };

  const labelFor = (dayKey: string): string =>
    dayLabelI18nKey
      ? dayLabelI18nKey(dayKey)
      : t(`workerRegistration.availability.${dayKey}`);

  const shortFor = (dayKey: string): string => t(`workerRegistration.availability.${dayKey}Short`);

  const openCopy = (dayIndex: number): void => {
    setConflictDays([]);
    setTargets([]);
    setCopyFrom(copyFrom === dayIndex ? null : dayIndex);
  };

  const toggleTarget = (dayIndex: number): void =>
    setTargets((prev) => (prev.includes(dayIndex) ? prev.filter((d) => d !== dayIndex) : [...prev, dayIndex]));

  const applyCopy = (): void => {
    if (copyFrom === null) return;
    const { next, conflictDays: conflicts } = copySlotsToDays(value, copyFrom, targets);
    onChange(next);
    setConflictDays(conflicts);
    setCopyFrom(null);
    setTargets([]);
  };

  const chip = (active: boolean): string =>
    `px-2 py-0.5 rounded-pill border text-xs transition-colors disabled:opacity-50 ${
      active ? 'bg-primary text-white border-primary' : 'border-gray-600 text-gray-800 hover:border-primary'
    }`;

  return (
    <div className="flex flex-col" data-testid="day-schedule-editor">
      {DAY_KEYS.map((dayKey, dayIndex) => {
        const daySlots = slotsByDay.get(dayIndex) ?? [];
        const isEnabled = daySlots.length > 0;
        const hasInvalid = daySlots.some((slot) => !isValidRange(slot));

        return (
          <div
            key={dayKey}
            data-testid={`day-schedule-row-${dayKey}`}
            className="flex flex-col gap-1 py-1.5 border-b border-gray-600 last:border-b-0"
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Text
                as="span"
                size="base"
                weight="medium"
                color={isEnabled ? 'primary' : 'secondary'}
                className="w-24 shrink-0"
              >
                {labelFor(dayKey)}
              </Text>

              <div className="flex flex-wrap items-center gap-2 flex-1 min-w-0">
                {daySlots.map((slot, slotIndex) => (
                  <div key={slotIndex} className="flex items-center gap-1">
                    <div
                      className={`flex items-center gap-1 px-2 py-0.5 rounded-input font-lexend text-white text-sm ${
                        isValidRange(slot) ? 'bg-primary' : 'bg-red-600'
                      }`}
                      aria-invalid={!isValidRange(slot)}
                    >
                      <TimeSelect
                        value={slot.startTime}
                        onChange={(e) => updateSlot(dayIndex, slotIndex, 'startTime', e.target.value)}
                        disabled={disabled}
                        step={5}
                        className="bg-transparent font-lexend text-white focus:outline-none text-sm cursor-pointer [&>option]:text-gray-900"
                      />
                      <Text as="span" size="sm" color="white">-</Text>
                      <TimeSelect
                        value={slot.endTime}
                        onChange={(e) => updateSlot(dayIndex, slotIndex, 'endTime', e.target.value)}
                        disabled={disabled}
                        step={5}
                        includeEndOfDay
                        className="bg-transparent font-lexend text-white focus:outline-none text-sm cursor-pointer [&>option]:text-gray-900"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => removeSlot(dayIndex, slotIndex)}
                      disabled={disabled}
                      aria-label={t('workerRegistration.availability.removeSlot', { defaultValue: 'Remover horario' })}
                      data-testid={`day-schedule-remove-${dayKey}-${slotIndex}`}
                      className="p-1 text-primary hover:text-red-500 transition-colors disabled:opacity-50"
                    >
                      <X className="w-3.5 h-3.5" strokeWidth={2.5} />
                    </button>
                  </div>
                ))}
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {isEnabled && (
                  <button
                    type="button"
                    onClick={() => openCopy(dayIndex)}
                    disabled={disabled || hasInvalid}
                    aria-expanded={copyFrom === dayIndex}
                    data-testid={`day-schedule-copy-${dayKey}`}
                    className="flex items-center gap-1 text-xs text-primary hover:underline disabled:opacity-50"
                  >
                    <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                    {t('workerRegistration.availability.copyTo')}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => addSlot(dayIndex)}
                  disabled={disabled}
                  aria-label={t('workerRegistration.availability.addSlot', { defaultValue: 'Agregar horario' })}
                  data-testid={`day-schedule-add-${dayKey}`}
                  className="p-1.5 rounded-pill bg-primary hover:bg-primary/90 transition-colors disabled:opacity-50"
                >
                  <Plus className="w-4 h-4 text-white" strokeWidth={2.5} />
                </button>
              </div>
            </div>

            {hasInvalid && (
              <Text as="span" size="xs" className="text-red-600" data-testid={`day-schedule-invalid-${dayKey}`}>
                {t('workerRegistration.availability.invalidRange')}
              </Text>
            )}

            {conflictDays.includes(dayIndex) && (
              <Text as="span" size="xs" color="secondary" data-testid={`day-schedule-conflict-${dayKey}`}>
                {t('workerRegistration.availability.copyConflict', { days: labelFor(dayKey) })}
              </Text>
            )}

            {copyFrom === dayIndex && (
              <div className="flex flex-wrap items-center gap-1.5" data-testid={`day-schedule-copy-panel-${dayKey}`}>
                {DAY_KEYS.map((k, i) =>
                  i === dayIndex ? null : (
                    <button
                      key={k}
                      type="button"
                      aria-pressed={targets.includes(i)}
                      onClick={() => toggleTarget(i)}
                      data-testid={`day-schedule-copy-target-${k}`}
                      className={chip(targets.includes(i))}
                    >
                      {shortFor(k)}
                    </button>
                  ),
                )}
                <button
                  type="button"
                  onClick={() => setTargets([1, 2, 3, 4, 5].filter((d) => d !== dayIndex))}
                  data-testid="day-schedule-copy-weekdays"
                  className={chip(false)}
                >
                  {t('workerRegistration.availability.copyWeekdays')}
                </button>
                <button
                  type="button"
                  onClick={() => setTargets([0, 1, 2, 3, 4, 5, 6].filter((d) => d !== dayIndex))}
                  data-testid="day-schedule-copy-all"
                  className={chip(false)}
                >
                  {t('workerRegistration.availability.copyAll')}
                </button>
                <button
                  type="button"
                  onClick={applyCopy}
                  disabled={targets.length === 0}
                  data-testid="day-schedule-copy-apply"
                  className="px-3 py-0.5 rounded-pill bg-primary text-white text-xs disabled:opacity-50"
                >
                  {t('workerRegistration.availability.copyApply')}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
