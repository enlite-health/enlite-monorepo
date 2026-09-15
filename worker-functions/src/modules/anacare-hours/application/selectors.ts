/**
 * src/modules/anacare-hours/application/selectors.ts
 *
 * Agregados DERIVADOS a partir de `AnaCareShift[]` — nunca guardados em coluna (mesma regra do
 * protótipo, `selectors.ts` do front). Funções puras, sem I/O — cobertura 100% trivial.
 */

import type { AnaCareOriginCounts, AnaCareShift } from '../domain/AnaCareShift';

/** D344: turno sem check-in soma 0h no total — modo `'zero'` é o ÚNICO usado em produção. */
export function totalHours(shifts: readonly AnaCareShift[]): number {
  return shifts.reduce((acc, s) => acc + (s.hoursActual ?? 0), 0);
}

export function originCounts(shifts: readonly AnaCareShift[]): AnaCareOriginCounts {
  const out: AnaCareOriginCounts = { sinCheckin: 0, webAdmin: 0, app: 0 };
  for (const s of shifts) {
    if (s.origin === 'sin_checkin') out.sinCheckin += 1;
    else if (s.origin === 'web_admin') out.webAdmin += 1;
    else out.app += 1;
  }
  return out;
}

export interface ValidationSummary {
  validated: number;
  total: number;
  contested: number;
}

export function validationSummary(shifts: readonly AnaCareShift[]): ValidationSummary {
  let validated = 0;
  let contested = 0;
  for (const s of shifts) {
    if (s.status === 'validado') validated += 1;
    else if (s.status === 'contestado') contested += 1;
  }
  return { validated, total: shifts.length, contested };
}

/** Diferença previsto × real em minutos — null quando não há check-in real (nunca destaca "sin check-in"). */
export function scheduleDiffMinutes(shift: AnaCareShift): number | null {
  if (shift.actualStart === null) return null;
  return Math.round((new Date(shift.actualStart).getTime() - new Date(shift.scheduledStart).getTime()) / 60_000);
}

/** D342: só destaca a partir de 15 min de diferença, e só com check-in real. */
export const HOURS_HIGHLIGHT_THRESHOLD_MINUTES = 15;

export function isHoursHighlighted(shift: AnaCareShift): boolean {
  const diff = scheduleDiffMinutes(shift);
  return diff !== null && Math.abs(diff) >= HOURS_HIGHLIGHT_THRESHOLD_MINUTES;
}

/** Checkbox só disponível em Pendiente/Contestado — validado congela (spec §Validação por turno). */
export function isShiftSelectable(shift: AnaCareShift): boolean {
  return shift.status !== 'validado';
}
