/**
 * src/modules/anacare-hours/domain/AnaCareHoursSyncPorts.ts
 *
 * Portas do sync real (F4 continuação, migration 439): o módulo `anacare-hours` não depende do
 * módulo `integration` por tipo nominal — `AnaCareEnliteDirectory` (integration) e
 * `AnaCareShiftRepository` (infra deste módulo) satisfazem estas portas ESTRUTURALMENTE, o mesmo
 * padrão que `AnaCareShiftsSource` já usa para desacoplar o serviço do adapter real/falso.
 */

import type { SourceShiftDTO } from './AnaCareShiftsSource';

export interface EnliteDirectoryEntry {
  reservationId: string;
}

export interface EnliteDirectorySnapshot {
  entries: readonly EnliteDirectoryEntry[];
  counts: { activo: number; terminado: number; total: number };
  /** `true` quando a página de TERMINADOS não pôde ser lida (diretório real, ver `AnaCareEnliteDirectory`). */
  partial: boolean;
}

/** Descobre quais reservas (contas) do Ana Care são da Enlite — a fonte NÃO tem filtro por agência. */
export interface EnliteDirectorySource {
  fetch(): Promise<EnliteDirectorySnapshot>;
}

export interface ShiftSyncFreshness {
  /** Quantos turnos o retrato tem gravado para o mês — zero é FALHA (retrato nunca construído), nunca sucesso silencioso. */
  shifts: number;
  lastFetchedAt: string | null;
}

/** Porta de escrita/leitura do retrato (`anacare_shift`) usada pelo sync runner E pelo serviço de leitura. */
export interface ShiftSyncRepository {
  upsertMany(shifts: readonly SourceShiftDTO[], periodMonth: string): Promise<{ written: number }>;
  listByMonth(month: string, patientId?: string): Promise<SourceShiftDTO[]>;
  getSnapshotFreshness(month: string): Promise<ShiftSyncFreshness>;
  /** Última contagem TOTAL do diretório Enlite conhecida (alarme de queda) — `null` = nenhuma execução prévia. */
  getLastDirectoryCount(): Promise<number | null>;
  setLastDirectoryCount(count: number): Promise<void>;
}
