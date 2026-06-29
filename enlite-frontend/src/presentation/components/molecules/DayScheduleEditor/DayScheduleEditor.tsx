import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, X } from 'lucide-react';
import { TimeSelect } from '@presentation/components/atoms/TimeSelect/TimeSelect';
import { Text } from '@presentation/components/atoms/Text';

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

  return (
    <div className="flex flex-col gap-4" data-testid="day-schedule-editor">
      {DAY_KEYS.map((dayKey, dayIndex) => {
        const daySlots = slotsByDay.get(dayIndex) ?? [];
        const isEnabled = daySlots.length > 0;

        return (
          <div
            key={dayKey}
            data-testid={`day-schedule-row-${dayKey}`}
            className={`flex flex-col px-4 py-4 rounded-card border-2 transition-all duration-200 ${
              isEnabled ? 'border-primary gap-3' : 'border-gray-600 gap-2'
            }`}
          >
            <div className="flex items-center justify-between">
              <Text
                as="span"
                size="base"
                weight="medium"
                color={isEnabled ? 'primary' : 'secondary'}
              >
                {labelFor(dayKey)}
              </Text>

              <div className="flex items-center gap-3">
                <Text as="span" size="sm" color="secondary">
                  {isEnabled
                    ? t('workerRegistration.availability.timeSlotsCount', { count: daySlots.length })
                    : t('workerRegistration.availability.timeSlots')}
                </Text>

                <button
                  type="button"
                  onClick={() => addSlot(dayIndex)}
                  disabled={disabled}
                  aria-label={t('workerRegistration.availability.addSlot', { defaultValue: 'Agregar horario' })}
                  data-testid={`day-schedule-add-${dayKey}`}
                  className="p-2 rounded-pill bg-primary hover:bg-primary/90 transition-colors disabled:opacity-50"
                >
                  <Plus className="w-4 h-4 text-white" strokeWidth={2.5} />
                </button>
              </div>
            </div>

            {isEnabled && (
              <div className="flex flex-wrap items-center gap-2 mt-2">
                {daySlots.map((slot, slotIndex) => (
                  <div key={slotIndex} className="flex items-center gap-2">
                    {slotIndex > 0 && (
                      <Text as="span" size="sm" color="secondary">|</Text>
                    )}
                    <div className="flex items-center gap-1 px-2 py-1 bg-primary rounded-input font-lexend text-white text-sm">
                      <TimeSelect
                        value={slot.startTime}
                        onChange={(e) => updateSlot(dayIndex, slotIndex, 'startTime', e.target.value)}
                        disabled={disabled}
                        step={30}
                        className="bg-transparent font-lexend text-white focus:outline-none text-sm cursor-pointer [&>option]:text-gray-900"
                      />
                      <Text as="span" size="sm" color="white">-</Text>
                      <TimeSelect
                        value={slot.endTime}
                        onChange={(e) => updateSlot(dayIndex, slotIndex, 'endTime', e.target.value)}
                        disabled={disabled}
                        step={30}
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
            )}
          </div>
        );
      })}
    </div>
  );
}
