/**
 * ItinerarySchedule — deriva as chaves de faixa semanal (`weekday`, `startTime`, `durationMinutes`)
 * do horário do serviço contratado (spec 056, plan.md §4.2). Turno = início + duração (1..1440 min);
 * o fim nunca é gravado nem aceito aqui (Início/Fin → duração é conta SÓ do front). Função pura:
 * sem banco, sem `Date`/`Intl`. O zod já barra a forma na borda; esta é a 2ª trava (o CHECK
 * `pis_duration_range` do banco é a 3ª).
 */

export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Um turno do horário: início + duração. weekday 0 = domingo. */
export interface ShiftEntry {
  dayOfWeek: number;
  startTime: string;
  durationMinutes: number;
}

export interface ItinerarySlotKey {
  weekday: number;
  startTime: string;
  durationMinutes: number;
}

/** Entrada fora da forma esperada (dia fora de 0-6, `HH:MM` inválido, duração fora de 1..1440). */
export class InvalidScheduleEntryError extends Error {
  constructor(readonly entry: unknown) {
    super(`invalid schedule entry: ${JSON.stringify(entry)}`);
    this.name = 'InvalidScheduleEntryError';
  }
}

function assertValidEntry(entry: ShiftEntry): void {
  const { dayOfWeek, startTime, durationMinutes } = entry;
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) throw new InvalidScheduleEntryError(entry);
  if (typeof startTime !== 'string' || !HHMM.test(startTime)) throw new InvalidScheduleEntryError(entry);
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 1440) {
    throw new InvalidScheduleEntryError(entry);
  }
}

/**
 * Valida e deduplica (chave `weekday|startTime|durationMinutes`), ordena por weekday, startTime,
 * durationMinutes. `null`/`undefined`/`[]` → `[]`. Entrada inválida lança ANTES de devolver
 * qualquer coisa. Só remove duplicata EXATA; faixas sobrepostas e distintas permanecem (a trava de
 * sobreposição é do banco, `pis_sem_sobreposicao`).
 */
export function shiftsToSlotKeys(entries: readonly ShiftEntry[] | null | undefined): ItinerarySlotKey[] {
  if (!entries || entries.length === 0) return [];

  const byKey = new Map<string, ItinerarySlotKey>();
  for (const entry of entries) {
    assertValidEntry(entry);
    const key = `${entry.dayOfWeek}|${entry.startTime}|${entry.durationMinutes}`;
    if (!byKey.has(key)) {
      byKey.set(key, { weekday: entry.dayOfWeek, startTime: entry.startTime, durationMinutes: entry.durationMinutes });
    }
  }

  return [...byKey.values()].sort(
    (a, b) =>
      a.weekday - b.weekday ||
      (a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1 : 0) ||
      a.durationMinutes - b.durationMinutes,
  );
}
