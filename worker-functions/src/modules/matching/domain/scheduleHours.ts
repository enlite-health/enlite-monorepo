/**
 * Cálculo de horas/semana a partir do JSONB `job_postings.schedule`.
 *
 * Forma persistida (Gemini / form admin): array de dia-turno
 *   `[{ dayOfWeek: number, startTime: 'HH:MM', endTime: 'HH:MM' }]`.
 * Cada entry JÁ É um dia-turno — NÃO multiplicar por nº de dias.
 *
 * NÃO parseia a coluna texto legada `schedule_days_hours` nem importa o parser
 * do frontend — calcula direto do JSONB. Virada de meia-noite: se end<=start,
 * a duração é `24 - start + end`.
 *
 * Lógica pura (sem I/O) para cobertura 100% em unit test.
 */

interface ScheduleEntry {
  dayOfWeek?: unknown;
  startTime?: unknown;
  endTime?: unknown;
}

/** "HH:MM" ou "HH:MM:SS" → horas decimais desde meia-noite; null se inválido. */
export function timeToHours(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = match[3] ? Number(match[3]) : 0;
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  return hours + minutes / 60 + seconds / 3600;
}

/**
 * Duração em horas de um turno "HH:MM"/"HH:MM:SS" → "HH:MM"/"HH:MM:SS".
 * Trata virada de meia-noite (end <= start → 24 - start + end).
 * Retorna `null` quando start/end não são horários válidos — chamadores
 * devem tratar `null` como "entrada inválida, ignorar" (nunca somar 0
 * silenciosamente, que colidiria com uma duração legítima de 0h).
 */
export function durationHours(start: string, end: string): number | null {
  const startHours = timeToHours(start);
  const endHours = timeToHours(end);
  if (startHours === null || endHours === null) return null;
  return endHours <= startHours ? 24 - startHours + endHours : endHours - startHours;
}

/**
 * Soma das horas/semana do schedule. Entradas inválidas são ignoradas.
 * Retorna 0 para schedule ausente, não-array ou vazio.
 */
export function computeScheduleWeeklyHours(schedule: unknown): number {
  if (!Array.isArray(schedule)) return 0;

  let total = 0;
  for (const raw of schedule) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as ScheduleEntry;
    if (typeof entry.startTime !== 'string' || typeof entry.endTime !== 'string') continue;

    const duration = durationHours(entry.startTime, entry.endTime);
    if (duration === null) continue;
    total += duration;
  }
  return total;
}

/** Um caso "tem schedule" quando o JSONB é um array não-vazio. */
export function hasStructuredSchedule(schedule: unknown): boolean {
  return Array.isArray(schedule) && schedule.length > 0;
}
