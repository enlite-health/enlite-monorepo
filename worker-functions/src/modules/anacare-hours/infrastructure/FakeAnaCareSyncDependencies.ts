/**
 * src/modules/anacare-hours/infrastructure/FakeAnaCareSyncDependencies.ts
 *
 * Contrapartes FALSAS de `EnliteDirectorySource`/`ShiftSyncRepository` — mesmo racional de
 * `FakeAnaCareShiftsSource` (nunca chamada de rede nem Pool real). Usadas SÓ quando
 * `ANACARE_HOURS_SOURCE=fake` (dev/e2e local) — o `AnaCareHoursSyncRunner` de produção usa
 * `AnaCareEnliteDirectory` (raspagem real) + `AnaCareShiftRepository` (Postgres real).
 *
 * `FakeEnliteDirectory` devolve DETERMINISTICAMENTE 1 reserva sintética — o suficiente para provar
 * o fan-out "1 reserva → 1 chamada a `source.listShifts`" sem gerar carga de teste desnecessária.
 */

import type { SourceShiftDTO } from '../domain/AnaCareShiftsSource';
import type { EnliteDirectorySnapshot, EnliteDirectorySource, ShiftSyncFreshness, ShiftSyncRepository } from '../domain/AnaCareHoursSyncPorts';

export class FakeEnliteDirectory implements EnliteDirectorySource {
  async fetch(): Promise<EnliteDirectorySnapshot> {
    return {
      entries: [{ reservationId: 'FAKE-RESV-0' }],
      counts: { activo: 1, terminado: 0, total: 1 },
      partial: false,
    };
  }
}

/** Em memória, vida do processo — nunca persiste entre reinícios (adequado só para dev/e2e local). */
export class FakeAnaCareShiftRepository implements ShiftSyncRepository {
  private readonly rows = new Map<string, SourceShiftDTO>();
  private lastFetchedAt: string | null = null;
  private lastDirectoryCount: number | null = null;

  async upsertMany(shifts: readonly SourceShiftDTO[], _periodMonth: string): Promise<{ written: number }> {
    for (const s of shifts) this.rows.set(s.sourceShiftId, s);
    if (shifts.length > 0) this.lastFetchedAt = new Date().toISOString();
    return { written: shifts.length };
  }

  async listByMonth(month: string, patientId?: string): Promise<SourceShiftDTO[]> {
    return [...this.rows.values()].filter((s) => s.date.slice(0, 7) === month && (!patientId || s.anaCarePatientId === patientId));
  }

  async getSnapshotFreshness(month: string): Promise<ShiftSyncFreshness> {
    const shifts = await this.listByMonth(month);
    return { shifts: shifts.length, lastFetchedAt: shifts.length > 0 ? this.lastFetchedAt : null };
  }

  async getLastDirectoryCount(): Promise<number | null> {
    return this.lastDirectoryCount;
  }

  async setLastDirectoryCount(count: number): Promise<void> {
    this.lastDirectoryCount = count;
  }
}
