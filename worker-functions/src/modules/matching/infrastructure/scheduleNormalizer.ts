/**
 * Converte o schedule armazenado em `job_postings.schedule` (JSONB) para o
 * formato consumido pelo frontend.
 *
 * - Forma persistida (Gemini / form admin via `scheduleToJsonb`): array
 *   `[{ dayOfWeek: number, startTime: string, endTime: string }]`
 * - Forma legada (criação manual antiga, sem `scheduleToJsonb`): objeto
 *   `{ lunes: [{ start, end }] }`
 * - Forma esperada pelo frontend: `{ <dayName>: [{ start, end }] }`
 */

const DAY_NAMES = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

export type NormalizedSchedule = Record<string, { start: string; end: string }[]>;

interface ArraySlot {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

export function normalizeSchedule(raw: unknown): NormalizedSchedule | null {
  if (!raw) return null;

  if (!Array.isArray(raw)) return raw as NormalizedSchedule;

  const result: NormalizedSchedule = {};
  for (const slot of raw as ArraySlot[]) {
    const dayName = DAY_NAMES[slot.dayOfWeek];
    if (!dayName) continue;
    if (!result[dayName]) result[dayName] = [];
    result[dayName].push({ start: slot.startTime, end: slot.endTime });
  }

  return Object.keys(result).length > 0 ? result : null;
}
