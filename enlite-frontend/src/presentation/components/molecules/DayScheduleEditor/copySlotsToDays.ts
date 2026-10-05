import type { DayScheduleSlot } from './DayScheduleEditor';

export interface CopySlotsResult {
  next: DayScheduleSlot[];
  /** Dias de destino em que ao menos uma faixa NÃO entrou por sobrepor uma existente (não idêntica). */
  conflictDays: number[];
}

const overlaps = (a: DayScheduleSlot, b: DayScheduleSlot): boolean =>
  a.startTime < b.endTime && b.startTime < a.endTime;

/** fim > início — a mesma regra do back (`startTime < endTime`). */
export const isValidRange = (slot: Pick<DayScheduleSlot, 'startTime' | 'endTime'>): boolean =>
  slot.startTime < slot.endTime;

/**
 * Copia as faixas de `fromDay` para os `targetDays`. ACRESCENTA — nunca substitui o destino: faixa
 * idêntica já existente é ignorada em silêncio; faixa que sobrepõe uma existente (não idêntica)
 * mantém a existente e o dia entra em `conflictDays` para o aviso.
 */
export function copySlotsToDays(value: DayScheduleSlot[], fromDay: number, targetDays: number[]): CopySlotsResult {
  const source = value.filter((s) => s.dayOfWeek === fromDay);
  const next = [...value];
  const conflictDays: number[] = [];
  for (const day of targetDays) {
    if (day === fromDay) continue;
    let conflict = false;
    for (const s of source) {
      const candidate = { ...s, dayOfWeek: day };
      const sameDay = next.filter((e) => e.dayOfWeek === day);
      if (sameDay.some((e) => e.startTime === candidate.startTime && e.endTime === candidate.endTime)) continue;
      if (sameDay.some((e) => overlaps(e, candidate))) {
        conflict = true;
        continue;
      }
      next.push(candidate);
    }
    if (conflict) conflictDays.push(day);
  }
  return { next, conflictDays };
}
