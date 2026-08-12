import { normalizeSchedule } from './scheduleNormalizer';
import { DAY_ORDER } from './formatScheduleToText';
import { durationHours } from '../domain/scheduleHours';
import type { ScheduleWeekDto } from '../domain/PublicJobDto';

/**
 * Deriva `schedule_week` — tabela semanal estruturada — a partir do JSONB
 * `job_postings.schedule`, pro plugin WordPress renderizar a grade de
 * horários sem re-parsear o texto livre `schedule_days_hours`.
 *
 * Reusa `normalizeSchedule` (mesma normalização usada por `formatScheduleToText`,
 * lida com ambas as formas do JSONB — array `[{dayOfWeek,startTime,endTime}]` e
 * objeto legado `{ <dia>: [{start,end}] }`) e `durationHours` (mesmo cálculo de
 * duração usado por `computeScheduleWeeklyHours`), pra tabela e horas nunca
 * divergirem entre si nem do restante do sistema.
 *
 * `is_coverage=true` significa "o horário NÃO é a jornada de uma única pessoa
 * (cobertura por turnos OU día completo/cama adentro) → o card do WordPress
 * renderiza como cobertura, não soma como horas individuais". Calibrado contra
 * dados reais de prod (183 vagas públicas):
 *   - ≥3 turnos distintos no mesmo dia da semana = rotação multi-AT genuína
 *     (ex: 08-14/14-20/20-08) — inequívoco, 3 turnos/dia só existe com
 *     revezamento entre pessoas.
 *   - Algum slot com `start === end` = convenção "día completo/cama adentro"
 *     (ex "08:00"→"08:00", "00:00"→"23:59"; `durationHours` trata como 24h
 *     via a regra `end <= start ⇒ 24 - start + end`). `weekly_hours` continua
 *     somando esses slots como 24h (não muda a semântica de `durationHours`),
 *     mas eles marcam `is_coverage=true` pra nunca aparecerem como
 *     "168 h por semana" de uma jornada de 1 pessoa.
 *
 * Lógica pura (sem I/O) — entrada inesperada (string, número, slot inválido)
 * nunca lança; retorna `null` quando o schedule não é estruturável ou não tem
 * nenhum turno válido.
 */

/** Sinal estrutural: dia com ≥ este nº de turnos distintos indica rotação multi-AT. */
const COVERAGE_MIN_SHIFTS_PER_DAY = 3;

interface ScheduleSlot {
  start?: unknown;
  end?: unknown;
}

function emptyDays(): ScheduleWeekDto['days'] {
  return {
    lunes: [],
    martes: [],
    miercoles: [],
    jueves: [],
    viernes: [],
    sabado: [],
    domingo: [],
  };
}

export function buildScheduleWeek(schedule: unknown): ScheduleWeekDto | null {
  const normalized = normalizeSchedule(schedule);
  if (!normalized || typeof normalized !== 'object') return null;

  const days = emptyDays();
  let totalHours = 0;
  let hasAnyShift = false;
  let coverageByShiftsPerDay = false;
  let coverageByFullDaySlot = false;

  for (const day of DAY_ORDER) {
    const slots = (normalized as Record<string, unknown>)[day];
    if (!Array.isArray(slots)) continue;

    let dayShiftCount = 0;
    for (const slot of slots) {
      if (!slot || typeof slot !== 'object') continue;
      const { start, end } = slot as ScheduleSlot;
      if (typeof start !== 'string' || typeof end !== 'string') continue;

      const duration = durationHours(start, end);
      if (duration === null) continue;

      days[day].push({ start, end });
      totalHours += duration;
      dayShiftCount += 1;
      hasAnyShift = true;

      if (start === end) coverageByFullDaySlot = true;
    }

    if (dayShiftCount >= COVERAGE_MIN_SHIFTS_PER_DAY) coverageByShiftsPerDay = true;
  }

  if (!hasAnyShift) return null;

  const weeklyHours = Math.round(totalHours * 100) / 100;
  const isCoverage = coverageByShiftsPerDay || coverageByFullDaySlot;

  return { days, weekly_hours: weeklyHours, is_coverage: isCoverage };
}
