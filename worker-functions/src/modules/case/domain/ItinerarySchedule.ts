/**
 * ItinerarySchedule — deriva as chaves de slot semanal (`weekday`, `startTime`, `endTime`) do
 * `schedule` do serviço contratado. O formato de entrada é o MESMO de `ContractedServiceScheduleSlot`
 * (`PatientContractedServiceRepository.ts:23-27`), redeclarado estruturalmente aqui — o domínio não
 * importa infraestrutura. Função pura: sem banco, sem `Date`/`Intl`; validação e ordenação são de
 * string. O zod já barra a forma na borda (`contractedServiceSchemas.ts`); esta é a 2ª trava (o CHECK
 * do banco, `pis_time_order`/`pis_weekday_range`, é a 3ª).
 */

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface ScheduleEntry {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

export interface ItinerarySlotKey {
  weekday: number;
  startTime: string;
  endTime: string;
}

/** Entrada fora da forma esperada (dia fora de 0-6, `HH:MM` inválido, `end <= start`). */
export class InvalidScheduleEntryError extends Error {
  constructor(readonly entry: ScheduleEntry) {
    super(`invalid schedule entry: ${JSON.stringify(entry)}`);
    this.name = 'InvalidScheduleEntryError';
  }
}

/**
 * "HH:MM" → minutos desde meia-noite (diferença `end - start`). Único lugar do domínio que
 * converte horário em minutos — `ServiceCoverageCalculator` reusa esta função em vez de duplicar
 * o `toMinutes` de `AddressAvailabilityCalculator.ts:96-99` (arquivo intocado, critério 8).
 */
export function slotMinutes(startTime: string, endTime: string): number {
  const toMinutes = (t: string): number => {
    const [h, m] = t.split(':').map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  return toMinutes(endTime) - toMinutes(startTime);
}

function assertValidEntry(entry: ScheduleEntry): void {
  const { dayOfWeek, startTime, endTime } = entry;
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
    throw new InvalidScheduleEntryError(entry);
  }
  if (!HHMM.test(startTime) || !HHMM.test(endTime)) {
    throw new InvalidScheduleEntryError(entry);
  }
  if (endTime <= startTime) {
    throw new InvalidScheduleEntryError(entry);
  }
}

/**
 * Deduplica e ordena as faixas do schedule em chaves de slot. `null`/`undefined`/`[]` → `[]`.
 * Dedup pela chave `weekday|startTime|endTime` — o schedule real da stage tem 3 faixas idênticas
 * (passo-0.md:709) e vira 1 slot. Faixas sobrepostas e distintas do mesmo serviço (08-12 e 10-14)
 * permanecem 2 slots (Q-7.4, não trava): esta função só remove duplicata EXATA da mesma chave, não
 * funde intervalos.
 */
export function scheduleToSlots(
  schedule: readonly ScheduleEntry[] | null | undefined,
): ItinerarySlotKey[] {
  if (!schedule || schedule.length === 0) return [];

  const byKey = new Map<string, ItinerarySlotKey>();
  for (const entry of schedule) {
    assertValidEntry(entry);
    const key = `${entry.dayOfWeek}|${entry.startTime}|${entry.endTime}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        weekday: entry.dayOfWeek,
        startTime: entry.startTime,
        endTime: entry.endTime,
      });
    }
  }

  return [...byKey.values()].sort((a, b) => {
    if (a.weekday !== b.weekday) return a.weekday - b.weekday;
    if (a.startTime !== b.startTime) return a.startTime < b.startTime ? -1 : 1;
    if (a.endTime !== b.endTime) return a.endTime < b.endTime ? -1 : 1;
    return 0;
  });
}
