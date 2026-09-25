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
  /** Chave como o backend manda (sem acento) — `lunes`, `miercoles`, … Não é texto de UI: é o
   *  identificador do dado (`DAY_KEYS_ES` do backend), por isso fica fora do i18n — quem traduz
   *  para exibição é o componente, via `admin.draftVacancy.days.short/full.<key>` (gate parcial
   *  25/09, achado #4: os RÓTULOS saíram daqui, só a CHAVE fica). */
  key: string;
  blocks: ScheduleBlock[];
}

/** Ordem de exibição Lun→Dom (o protótipo v3 é semana-comercial, não semana ISO nem `getDay()`). */
const DAY_ORDER: readonly string[] = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];

/** As 7 posições da grade, cada uma com os blocos do dia (`[]` = "sin atención"). */
export function buildScheduleGrid(schedule: NormalizedSchedule | null | undefined): ScheduleGridDay[] {
  return DAY_ORDER.map((key) => ({
    key,
    blocks: schedule?.[key] ?? [],
  }));
}

/**
 * "08:00" → "8"; "14:30" → "14:30" (protótipo v3: sem zero à esquerda na hora, minutos só
 * quando ≠ ":00" — gate parcial 25/09, achado #5b). Entrada fora do formato HH:MM volta como
 * veio, sem lançar — a grade não pode quebrar por um valor que o backend um dia mande diferente.
 */
export function formatScheduleTime(value: string): string {
  const m = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return value;
  const hour = String(Number(m[1]));
  const minutes = m[2];
  return minutes === '00' ? hour : `${hour}:${minutes}`;
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
