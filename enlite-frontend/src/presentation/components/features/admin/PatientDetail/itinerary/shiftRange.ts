import type { TFunction } from 'i18next';
import { shiftMinutes } from '@domain/scheduleHours';

type Shift = { startTime: string; endTime?: string | null; durationMinutes?: number | null };

const hhmm = (t: string): string => t.slice(0, 5);

/** "09" / "09:30": a hora cheia perde os minutos (o rótulo compacto é curto: "09–17"). */
const hourOf = (t: string): string => (hhmm(t).endsWith(':00') ? t.slice(0, 2) : hhmm(t));

/** Turno de 24 h: pela duração, quando a API a manda; senão pela regra única (`shiftMinutes`: Fin = Inicio ⇒ 1440). */
export function isAllDayShift(s: Shift): boolean {
  if (s.durationMinutes != null) return s.durationMinutes === 1440;
  return !!s.endTime && shiftMinutes(hhmm(s.startTime), hhmm(s.endTime)) === 1440;
}

/** O rótulo ÚNICO de um turno: "HH:MM – HH:MM" (`full`) ou "HH–HH" (`compact`); turno de 24 h vira "Todo el día · 24 h" / "24 h". */
export function shiftRangeLabel(t: TFunction, s: Shift & { endTime: string }, style: 'full' | 'compact' = 'full'): string {
  if (isAllDayShift(s)) {
    return t(style === 'full' ? 'admin.patients.editDrawer.shift.allDayRange' : 'admin.patients.editDrawer.shift.allDayCompact');
  }
  return style === 'full' ? `${hhmm(s.startTime)} – ${hhmm(s.endTime)}` : `${hourOf(s.startTime)}–${hourOf(s.endTime)}`;
}
