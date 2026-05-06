/**
 * VacancyDaySchedulePicker
 *
 * Per-day card UI for the vacancy schedule field.
 * Mirrors the AvailabilityTab pattern: one card per day with inline
 * time-slot pills (start–end) and add/remove controls.
 *
 * Data flow:
 *   ScheduleValue (array of {days, timeFrom, timeTo}) ↔ per-day Map
 *   - valueToDaysMap: expand ScheduleValue entries onto each day bucket
 *   - daysMapToValue: collapse per-day buckets back to ScheduleValue format
 */

import { useTranslation } from 'react-i18next';
import { TimeSelect } from '@presentation/components/atoms';
import {
  DAY_KEYS,
  findNextAvailableSlot,
  type DayKey,
  type ScheduleValue,
} from '../vacancyScheduleUtils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SlotMap = Record<DayKey, { startTime: string; endTime: string }[]>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function valueToDaysMap(value: ScheduleValue): SlotMap {
  const map: Record<string, { startTime: string; endTime: string }[]> = {
    lun: [],
    mar: [],
    mie: [],
    jue: [],
    vie: [],
    sab: [],
    dom: [],
  };

  for (const entry of value) {
    if (!entry.timeFrom || !entry.timeTo) continue;
    for (const d of entry.days) {
      if (map[d]) {
        map[d].push({ startTime: entry.timeFrom, endTime: entry.timeTo });
      }
    }
  }

  return map as SlotMap;
}

function daysMapToValue(map: SlotMap): ScheduleValue {
  const result: ScheduleValue = [];

  for (const day of DAY_KEYS) {
    for (const slot of map[day]) {
      result.push({ days: [day], timeFrom: slot.startTime, timeTo: slot.endTime });
    }
  }

  return result.length > 0 ? result : [{ days: [], timeFrom: '', timeTo: '' }];
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface VacancyDaySchedulePickerProps {
  value: ScheduleValue;
  onChange: (value: ScheduleValue) => void;
  error?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function VacancyDaySchedulePicker({
  value,
  onChange,
  error,
}: VacancyDaySchedulePickerProps): JSX.Element {
  const { t } = useTranslation();

  const daysMap = valueToDaysMap(value);

  const addSlot = (day: DayKey) => {
    const suggestion = findNextAvailableSlot(daysMap[day]);
    if (!suggestion) return;
    const next: SlotMap = { ...daysMap, [day]: [...daysMap[day], suggestion] };
    onChange(daysMapToValue(next));
  };

  const removeSlot = (day: DayKey, idx: number) => {
    const next: SlotMap = {
      ...daysMap,
      [day]: daysMap[day].filter((_, i) => i !== idx),
    };
    onChange(daysMapToValue(next));
  };

  const updateSlot = (
    day: DayKey,
    idx: number,
    field: 'startTime' | 'endTime',
    val: string,
  ) => {
    const updatedSlots = daysMap[day].map((s, i) =>
      i === idx ? { ...s, [field]: val } : s,
    );
    const next: SlotMap = { ...daysMap, [day]: updatedSlots };
    onChange(daysMapToValue(next));
  };

  return (
    <div className="flex flex-col gap-3">
      {DAY_KEYS.map((day) => {
        const slots = daysMap[day];
        const enabled = slots.length > 0;
        const dayLabel = t(`admin.vacancyDetail.vacancyForm.days.${day}`);
        const dayFull = findNextAvailableSlot(slots) === null;

        return (
          <div
            key={day}
            className={`flex flex-col px-4 py-4 rounded-card border-2 transition-all duration-200 ${
              enabled ? 'border-primary gap-3' : 'border-[#D9D9D9] gap-2'
            }`}
          >
            {/* Card header */}
            <div className="flex items-center justify-between">
              <div
                className={`font-lexend font-medium text-base ${
                  enabled ? 'text-primary' : 'text-gray-800'
                }`}
              >
                {dayLabel}
              </div>

              <div className="flex items-center gap-3">
                <div className="font-lexend text-gray-800 text-sm">
                  {enabled && slots.length > 0
                    ? t('admin.vacancyModal.scheduleSlotsCount', { count: slots.length })
                    : t('admin.vacancyModal.scheduleSlotsLabel')}
                </div>

                <button
                  type="button"
                  onClick={() => addSlot(day)}
                  disabled={dayFull}
                  className={`p-2 rounded-pill transition-colors ${
                    dayFull
                      ? 'bg-gray-300 cursor-not-allowed'
                      : 'bg-primary hover:bg-primary/90'
                  }`}
                  aria-label={t('admin.vacancyModal.scheduleSlotsLabel')}
                  title={dayFull ? t('admin.vacancyModal.scheduleDayFull') : undefined}
                >
                  <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
                    <path
                      d="M10 5V15M5 10H15"
                      stroke="white"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </div>
            </div>

            {/* Time-slot pills */}
            {enabled && slots.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 mt-2">
                {slots.map((slot, i) => (
                  <div key={i} className="flex items-center gap-2">
                    {i > 0 && <span className="text-gray-500">|</span>}
                    <div className="flex items-center gap-1 px-2 py-1 bg-primary rounded-input font-lexend text-white text-sm">
                      <TimeSelect
                        value={slot.startTime}
                        onChange={(e) => updateSlot(day, i, 'startTime', e.target.value)}
                        className="bg-transparent font-lexend text-white focus:outline-none text-sm cursor-pointer [&>option]:text-gray-900"
                      />
                      <span className="text-white">-</span>
                      <TimeSelect
                        value={slot.endTime}
                        onChange={(e) => updateSlot(day, i, 'endTime', e.target.value)}
                        includeEndOfDay
                        className="bg-transparent font-lexend text-white focus:outline-none text-sm cursor-pointer [&>option]:text-gray-900"
                      />
                    </div>

                    <button
                      type="button"
                      onClick={() => removeSlot(day, i)}
                      className="p-1 text-primary hover:text-red-500 transition-colors"
                      aria-label={t('admin.vacancyModal.scheduleRemoveSlot')}
                    >
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M8 9.7L2 15.7 0.3 14 6.3 8 0.3 2 2 0.3 8 6.3 14 0.3 15.7 2 9.7 8 15.7 14 14 15.7 8 9.7Z" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {error && <span className="text-xs text-red-500">{error}</span>}
    </div>
  );
}
