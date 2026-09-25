/**
 * draftVacancySchedule — a grade de 7 dias do rascunho (fase 2, protótipo v3, F24/F28).
 *
 * `vacancy.schedule`, no GET, já vem NORMALIZADO pelo backend (`normalizeSchedule`,
 * `VacanciesController.ts`) para `Record<dayNameSemAcento, {start,end}[]>` — as chaves são
 * `DAY_KEYS_ES` (`worker-functions/src/shared/utils/dateFormatters.ts`): domingo, lunes, martes,
 * miercoles, jueves, viernes, sabado. Dia com MAIS de um bloco já chega como array com mais de um
 * elemento (F28 confirmado: 205 vagas em prd com ≥2 blocos no mesmo dia) — esta função só
 * reordena para exibição, nunca funde nem descarta bloco.
 */

export interface ScheduleBlock {
  start: string;
  end: string;
}

export type NormalizedSchedule = Record<string, ScheduleBlock[]>;

export interface ScheduleGridDay {
  /** Chave como o backend manda (sem acento) — `lunes`, `miercoles`, … */
  key: string;
  /** Rótulo curto pt. do protótipo v3 — Lun, Mar, Mié, Jue, Vie, Sáb, Dom. */
  short: string;
  /** Rótulo completo, para `aria-label`. */
  full: string;
  blocks: ScheduleBlock[];
}

/** Ordem de exibição Lun→Dom (o protótipo v3 é semana-comercial, não semana ISO nem `getDay()`). */
const DAY_ORDER: ReadonlyArray<{ key: string; short: string; full: string }> = [
  { key: 'lunes', short: 'Lun', full: 'lunes' },
  { key: 'martes', short: 'Mar', full: 'martes' },
  { key: 'miercoles', short: 'Mié', full: 'miércoles' },
  { key: 'jueves', short: 'Jue', full: 'jueves' },
  { key: 'viernes', short: 'Vie', full: 'viernes' },
  { key: 'sabado', short: 'Sáb', full: 'sábado' },
  { key: 'domingo', short: 'Dom', full: 'domingo' },
];

/** As 7 posições da grade, cada uma com os blocos do dia (`[]` = "sin atención"). */
export function buildScheduleGrid(schedule: NormalizedSchedule | null | undefined): ScheduleGridDay[] {
  return DAY_ORDER.map((d) => ({
    key: d.key,
    short: d.short,
    full: d.full,
    blocks: schedule?.[d.key] ?? [],
  }));
}

function parseHHMMToMinutes(value: string): number | null {
  const m = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (Number.isNaN(h) || Number.isNaN(min)) return null;
  return h * 60 + min;
}

/** Total de horas/semana somando todos os blocos de todos os dias — trata virada de meia-noite. */
export function weeklyHoursFromSchedule(schedule: NormalizedSchedule | null | undefined): number {
  if (!schedule) return 0;
  let totalMinutes = 0;
  for (const blocks of Object.values(schedule)) {
    for (const { start, end } of blocks) {
      const from = parseHHMMToMinutes(start);
      const to = parseHHMMToMinutes(end);
      if (from === null || to === null) continue;
      totalMinutes += to > from ? to - from : 24 * 60 - from + to;
    }
  }
  return Math.round((totalMinutes / 60) * 100) / 100;
}

/** Quantos dias distintos têm ao menos 1 bloco — o "en 6 días" do protótipo v3. */
export function daysWithAttendanceCount(schedule: NormalizedSchedule | null | undefined): number {
  if (!schedule) return 0;
  return Object.values(schedule).filter((blocks) => blocks.length > 0).length;
}
