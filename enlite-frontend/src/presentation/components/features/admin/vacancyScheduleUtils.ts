export interface ScheduleEntry {
  days: string[];
  timeFrom: string;
  timeTo: string;
}

/** A schedule is an array of entries, each with its own days + time range. */
export type ScheduleValue = ScheduleEntry[];

export const DAY_KEYS = ['lun', 'mar', 'mie', 'jue', 'vie', 'sab', 'dom'] as const;
export type DayKey = typeof DAY_KEYS[number];

export const DAY_LABELS: Record<DayKey, string> = {
  lun: 'Lunes',
  mar: 'Martes',
  mie: 'Miércoles',
  jue: 'Jueves',
  vie: 'Viernes',
  sab: 'Sábado',
  dom: 'Domingo',
};

const LABEL_TO_KEY: Record<string, DayKey> = {
  lunes: 'lun',
  martes: 'mar',
  miércoles: 'mie',
  miercoles: 'mie',
  jueves: 'jue',
  viernes: 'vie',
  sábado: 'sab',
  sabado: 'sab',
  domingo: 'dom',
};

/**
 * Parseia um único bloco "Lunes, Martes 09:00-17:00" em um ScheduleEntry.
 */
function parseSingleBlock(raw: string): ScheduleEntry | null {
  if (!raw.trim()) return null;

  const timeMatch = raw.match(/(\d{1,2}:\d{2})-(\d{1,2}:\d{2})/);
  if (!timeMatch) return null;

  const timeFrom = timeMatch[1].padStart(5, '0');
  const timeTo = timeMatch[2].padStart(5, '0');

  const daysPart = raw
    .replace(/\d{1,2}:\d{2}-\d{1,2}:\d{2}/, '')
    .trim()
    .replace(/,$/, '');

  const days: string[] = daysPart
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .map((d) => LABEL_TO_KEY[d])
    .filter(Boolean);

  if (days.length === 0) return null;

  return { days, timeFrom, timeTo };
}

/**
 * Parseia uma string de schedule que pode conter múltiplos blocos separados por " | ".
 * Ex: "Lunes, Martes 09:00-12:00 | Jueves 14:00-18:00"
 */
export function parseScheduleString(raw: string): ScheduleValue | null {
  if (!raw) return null;

  const blocks = raw.split('|').map((b) => b.trim());
  const entries = blocks.map(parseSingleBlock).filter(Boolean) as ScheduleEntry[];

  return entries.length > 0 ? entries : null;
}

/**
 * Calcula o total de horas semanais cobertas por um ScheduleValue.
 * Soma (endTime - startTime) × número de dias para cada entry. Trata virada
 * de meia-noite (endTime < startTime → (24 - startHour) + endHour). Entries
 * incompletos (sem dias ou sem horário válido) contribuem 0.
 */
export function computeWeeklyHours(value: ScheduleValue): number {
  let total = 0;
  for (const entry of value) {
    if (!entry.days.length || !entry.timeFrom || !entry.timeTo) continue;
    const fromMin = parseTimeToMinutes(entry.timeFrom);
    const toMin = parseTimeToMinutes(entry.timeTo);
    if (fromMin === null || toMin === null) continue;
    const slotMinutes = toMin > fromMin ? toMin - fromMin : 24 * 60 - fromMin + toMin;
    total += (slotMinutes / 60) * entry.days.length;
  }
  // Round to 2 decimals to avoid floating-point noise.
  return Math.round(total * 100) / 100;
}

function parseTimeToMinutes(value: string): number | null {
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (Number.isNaN(h) || Number.isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

/**
 * Encontra o próximo intervalo livre num conjunto de slots já existentes para
 * sugerir como default ao adicionar um novo turno num mesmo dia.
 *
 * Regras:
 *  - Sem slots → default `09:00–17:00` (preserva UX original).
 *  - Com slots → procura o primeiro gap APÓS o último slot existente; se não
 *    couber `step` minutos lá, escolhe o maior gap interno restante.
 *  - Não retorna timestamps que o `TimeSelect` (step=30min) não consiga
 *    representar — `endTime` é capado em `23:30`, último valor selecionável.
 *  - Retorna `null` quando o dia já está saturado (sem gap ≥ step).
 */
export function findNextAvailableSlot(
  slots: { startTime: string; endTime: string }[],
  step = 30,
): { startTime: string; endTime: string } | null {
  // O endTime aceita `23:59` (TimeSelect com includeEndOfDay) — último valor
  // HH:mm canônico do dia. Mantemos esse cap em vez de `24:00` para não
  // quebrar libs/validators/Postgres que rejeitam horas fora de 00–23.
  const LAST_PICKABLE_END = 23 * 60 + 59;
  const minToTime = (m: number): string => {
    const h = Math.floor(m / 60);
    const min = m % 60;
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  };

  const sorted = slots
    .map((s) => ({
      start: parseTimeToMinutes(s.startTime),
      end: parseTimeToMinutes(s.endTime),
    }))
    .filter(
      (s): s is { start: number; end: number } =>
        s.start !== null && s.end !== null && s.end > s.start,
    )
    .sort((a, b) => a.start - b.start);

  if (sorted.length === 0) {
    return { startTime: '09:00', endTime: '17:00' };
  }

  const lastEnd = sorted[sorted.length - 1].end;
  if (LAST_PICKABLE_END - lastEnd >= step) {
    return {
      startTime: minToTime(lastEnd),
      endTime: minToTime(LAST_PICKABLE_END),
    };
  }

  let cursor = 0;
  let bestGap: { start: number; end: number; size: number } | null = null;
  for (const s of sorted) {
    const size = s.start - cursor;
    if (size >= step && (!bestGap || size > bestGap.size)) {
      bestGap = { start: cursor, end: s.start, size };
    }
    cursor = Math.max(cursor, s.end);
  }

  if (!bestGap) return null;
  return {
    startTime: minToTime(bestGap.start),
    endTime: minToTime(Math.min(bestGap.end, LAST_PICKABLE_END)),
  };
}

/**
 * Serializa um ScheduleValue (array de entries) para string.
 * Ex: "Lunes, Martes 09:00-12:00 | Jueves 14:00-18:00"
 */
export function serializeSchedule(value: ScheduleValue): string {
  const parts = value
    .filter((e) => e.days.length > 0 && e.timeFrom && e.timeTo)
    .map((e) => {
      const dayNames = e.days.map((k) => DAY_LABELS[k as DayKey] ?? k).join(', ');
      return `${dayNames} ${e.timeFrom}-${e.timeTo}`;
    });
  return parts.join(' | ');
}
