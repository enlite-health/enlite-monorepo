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

const WEEK_MINUTES = 7 * 1440;

/** Início (minutos da SEMANA, domingo 00:00 = 0) e duração do turno; `null` se inválido (Fin = Inicio sem "Todo el día", HH:MM ruim). */
function weekInterval(sh: ServiceShiftFormValue): { start: number; length: number } | null {
  const length = sh.allDay ? 1440 : sh.startTime === sh.endTime ? null : shiftMinutes(sh.startTime, sh.endTime);
  const s = toMinutes(sh.startTime);
  return length === null || s === null ? null : { start: sh.dayOfWeek * 1440 + s, length };
}

/** Sobreposição na semana CIRCULAR: o turno que atravessa a meia-noite de sábado cai no domingo (mesma régua da 528 / `pis_sem_sobreposicao`). */
function overlapsInWeek(a: { start: number; length: number }, b: { start: number; length: number }): boolean {
  return [-WEEK_MINUTES, 0, WEEK_MINUTES].some((shift) => a.start < b.start + shift + b.length && b.start + shift < a.start + a.length);
}

export interface CopyShiftsResult {
  next: ServiceShiftFormValue[];
  /** Dias de destino em que ao menos um turno NÃO entrou por sobrepor um existente (não idêntico). */
  conflictDays: number[];
}

/**
 * "Copiar a…" do editor de turnos do serviço (058 P5d). ACRESCENTA — nunca substitui o destino: turno idêntico já existente é ignorado em
 * silêncio; turno que sobrepõe (em minutos da semana) QUALQUER turno existente mantém o existente e o dia entra em `conflictDays`.
 * NÃO reusa `copySlotsToDays` (compara `HH:MM` como string; erraria turno noturno e "Todo el día").
 */
export function copyShiftsToDays(value: ReadonlyArray<ServiceShiftFormValue>, fromDay: number, targetDays: number[]): CopyShiftsResult {
  const source = value.filter((s) => s.dayOfWeek === fromDay);
  const next = [...value];
  const conflictDays: number[] = [];
  for (const day of targetDays) {
    if (day === fromDay) continue;
    let conflict = false;
    for (const s of source) {
      const candidate = { ...s, dayOfWeek: day };
      if (next.some((e) => e.dayOfWeek === day && e.startTime === candidate.startTime && e.endTime === candidate.endTime && e.allDay === candidate.allDay)) continue;
      const cand = weekInterval(candidate);
      if (cand === null || next.some((e) => { const iv = weekInterval(e); return iv !== null && overlapsInWeek(iv, cand); })) {
        conflict = true;
        continue;
      }
      next.push(candidate);
    }
    if (conflict) conflictDays.push(day);
  }
  return { next, conflictDays };
}
