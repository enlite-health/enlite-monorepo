import { shiftMinutes, type ServiceShiftFormValue } from '@domain/scheduleHours';

/** O turno padrão de uma linha nova (editor do serviço e campo da guardia): um dono só. */
export const NEW_SHIFT = { startTime: '09:00', endTime: '17:00' };

export const isEqualWithoutAllDay = (sh: ServiceShiftFormValue): boolean => !sh.allDay && sh.startTime === sh.endTime;
export const minutesOf = (sh: ServiceShiftFormValue): number | null => (sh.allDay ? 1440 : isEqualWithoutAllDay(sh) ? null : shiftMinutes(sh.startTime, sh.endTime));

export const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export const chip = (active: boolean): string =>
  `px-2 py-0.5 rounded-pill border text-xs transition-colors disabled:opacity-50 ${
    active ? 'bg-primary text-white border-primary' : 'border-gray-600 text-gray-800 hover:border-primary'
  }`;
