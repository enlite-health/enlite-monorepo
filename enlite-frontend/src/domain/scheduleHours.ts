/**
 * UMA função de horas do front (spec 056, plan §4.8): a regra Inicio/Fin → minutos vive aqui e
 * em mais nenhum lugar. O back guarda `durationMinutes`; o front nunca manda `Fin`.
 */

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function toMinutes(hhmm: string): number | null {
  const m = HHMM.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Minutos de um turno pela regra única: end > start → end − start; end < start → 1440 − start + end; end = start → 1440. null se HH:MM inválido. */
export function shiftMinutes(startTime: string, endTime: string): number | null {
  const s = toMinutes(startTime);
  const e = toMinutes(endTime);
  if (s === null || e === null) return null;
  if (e === s) return 1440;
  return e > s ? e - s : 1440 - s + e;
}

/** Σ horas/semana de entradas {startTime, endTime} ou {startTime, durationMinutes}; inválidas ignoradas; arredonda a 2 casas. */
export function weeklyHoursOf(entries: ReadonlyArray<{ startTime: string; endTime?: string; durationMinutes?: number }>): number {
  let minutes = 0;
  for (const entry of entries) {
    const m = entry.durationMinutes !== undefined
      ? (Number.isInteger(entry.durationMinutes) && entry.durationMinutes >= 1 && entry.durationMinutes <= 1440 ? entry.durationMinutes : null)
      : (entry.endTime !== undefined ? shiftMinutes(entry.startTime, entry.endTime) : null);
    if (m !== null) minutes += m;
  }
  return Math.round((minutes / 60) * 100) / 100;
}

/** Valor do formulário de turnos do serviço (plan §7). `endTime` só existe na tela; não viaja. */
export interface ServiceShiftFormValue {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  allDay: boolean;
}

/** Turno do formulário → `{dayOfWeek, startTime, durationMinutes}` (plan §7.1). Turno inválido (Fin = Inicio sem "Todo el día", HH:MM ruim) é descartado — o formulário já barra o Guardar antes. */
export function shiftsToSlots(
  shifts: ReadonlyArray<ServiceShiftFormValue>,
): Array<{ dayOfWeek: number; startTime: string; durationMinutes: number }> {
  const slots: Array<{ dayOfWeek: number; startTime: string; durationMinutes: number }> = [];
  for (const sh of shifts) {
    const durationMinutes = sh.allDay ? 1440 : (sh.startTime === sh.endTime ? null : shiftMinutes(sh.startTime, sh.endTime));
    if (durationMinutes !== null) slots.push({ dayOfWeek: sh.dayOfWeek, startTime: sh.startTime, durationMinutes });
  }
  return slots;
}

/** Turno da API → formulário: `allDay = durationMinutes === 1440`; `endTime` = o derivado pela API (ou calculado, se faltar). */
export function slotsToShifts(
  slots: ReadonlyArray<{ dayOfWeek: number; startTime: string; durationMinutes: number; endTime?: string }>,
): ServiceShiftFormValue[] {
  return slots.map((sl) => {
    const start = sl.startTime.slice(0, 5);
    const s = toMinutes(start) ?? 0;
    const e = (s + sl.durationMinutes) % 1440;
    const derived = `${String(Math.floor(e / 60)).padStart(2, '0')}:${String(e % 60).padStart(2, '0')}`;
    return { dayOfWeek: sl.dayOfWeek, startTime: start, endTime: sl.endTime ? sl.endTime.slice(0, 5) : derived, allDay: sl.durationMinutes === 1440 };
  });
}
