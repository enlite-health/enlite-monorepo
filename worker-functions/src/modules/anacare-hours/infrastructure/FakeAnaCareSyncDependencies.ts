/**
 * src/modules/anacare-hours/infrastructure/FakeAnaCareSyncDependencies.ts
 *
 * Contrapartes FALSAS de `EnliteDirectorySource`/`DirectorySnapshotRepository`/`PatientMonthSyncRepository`
 * — mesmo racional de `FakeAnaCareShiftsSource` (nunca chamada de rede nem Pool real). Usadas SÓ
 * quando `ANACARE_HOURS_SOURCE=fake` (dev/e2e local) — o `AnaCareHoursSyncRunner` de produção usa
 * `AnaCareEnliteDirectory` (raspagem real) + `AnaCareDirectorySnapshotRepository`/`AnaCarePatientMonthRepository`
 * (Postgres real).
 *
 * `FakeEnliteDirectory` devolve DETERMINISTICAMENTE 1 reserva sintética — o suficiente para provar
 * o fan-out "1 reserva → 1 chamada a `source.listShifts`" sem gerar carga de teste desnecessária.
 */

import type { SourceShiftDTO } from '../domain/AnaCareShiftsSource';
import type {
  DirectorySnapshotRepository,
  EnliteDirectorySnapshot,
  EnliteDirectorySource,
  PatientMonthSyncRepository,
  ShiftSyncFreshness,
  SyncRunConclusion,
  SyncRunProgress,
  SyncRunRepository,
} from '../domain/AnaCareHoursSyncPorts';
import type { AnaCarePatientMonthAggregate, AnaCarePatientMonthProviderAggregate } from '../domain/AnaCarePatientMonth';
import { aggregatePatientMonth } from '../application/AnaCarePatientMonthAggregator';
import { FakeAnaCareShiftsSource } from './FakeAnaCareShiftsSource';
import { AnaCarePatientMonthCollisionError } from './AnaCarePatientMonthRepository';

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export class FakeEnliteDirectory implements EnliteDirectorySource {
  async fetch(): Promise<EnliteDirectorySnapshot> {
    return {
      entries: [{ reservationId: 'FAKE-RESV-0' }],
      counts: { activo: 1, terminado: 0, total: 1 },
      partial: false,
    };
  }
}

/**
 * Extraído de `FakeAnaCareShiftRepository` (passo 2, conserto 17/09) — o retrato por turno morreu
 * (`AnaCareShiftRepository` apagado, sem escritor/leitor de produção desde o passo 1), mas o
 * alarme de queda do diretório continua precisando de uma linha-base em memória para os testes.
 */
export class FakeAnaCareDirectorySnapshotRepository implements DirectorySnapshotRepository {
  private lastDirectoryCount: number | null = null;

  async getLastDirectoryCount(): Promise<number | null> {
    return this.lastDirectoryCount;
  }

  async setLastDirectoryCount(count: number): Promise<void> {
    this.lastDirectoryCount = count;
  }
}

/**
 * Contraparte falsa de `SyncRunRepository` (`anacare_sync_run`, migration 443) — em memória, vida
 * do processo. Mesmo contrato do real: `startNewRun` sempre substitui pelo carimbo `new Date()`
 * atual (aqui, o relógio do processo — o real usa `NOW()` do banco); `getRunStartedAt` devolve
 * `null` quando não há corrida registrada para `(source, periodMonth)`.
 */
export class FakeAnaCareSyncRunRepository implements SyncRunRepository {
  private readonly runs = new Map<string, Date>();
  /** F1 (migration 457) — espelha a semântica COALESCE do repositório real (ver `recordProgress`). */
  private readonly progress = new Map<string, SyncRunProgress>();

  private key(source: string, periodMonth: string): string {
    return `${source}::${periodMonth}`;
  }

  async startNewRun(source: string, periodMonth: string): Promise<Date> {
    const now = new Date();
    this.runs.set(this.key(source, periodMonth), now);
    return now;
  }

  async getRunStartedAt(source: string, periodMonth: string): Promise<Date | null> {
    return this.runs.get(this.key(source, periodMonth)) ?? null;
  }

  /**
   * Mesma semântica COALESCE de `AnaCareSyncRunRepository.recordProgress`: `cursor`/
   * `reservationsTotal`/`reservationsDone` como `null` preservam o valor já gravado em memória;
   * `finishedAt`/`lastError` são sempre sobrescritos pelo valor recebido.
   */
  async recordProgress(source: string, periodMonth: string, progress: SyncRunProgress): Promise<void> {
    const key = this.key(source, periodMonth);
    const prev = this.progress.get(key);
    this.progress.set(key, {
      status: progress.status,
      cursor: progress.cursor ?? prev?.cursor ?? null,
      reservationsTotal: progress.reservationsTotal ?? prev?.reservationsTotal ?? null,
      reservationsDone: progress.reservationsDone ?? prev?.reservationsDone ?? null,
      finishedAt: progress.finishedAt,
      lastError: progress.lastError,
    });
  }

  /** Só para teste/dev em modo fake — espelha o que o real leria de volta do banco. */
  getProgress(source: string, periodMonth: string): SyncRunProgress | null {
    return this.progress.get(this.key(source, periodMonth)) ?? null;
  }

  /**
   * F2 — espelha `AnaCareSyncRunRepository.getConclusion`: nenhuma rodada gravada em memória para
   * `(source, periodMonth)` (nem `startNewRun` nem `recordProgress` foram chamados) é o MESMO
   * "não sei" que uma linha real com `status IS NULL` — os 3 campos vêm `null`, nunca um `0`
   * inventado (mesma régua do repositório real).
   */
  async getConclusion(source: string, periodMonth: string): Promise<SyncRunConclusion> {
    const progress = this.progress.get(this.key(source, periodMonth));
    return {
      status: progress?.status ?? null,
      reservationsTotal: progress?.reservationsTotal ?? null,
      reservationsDone: progress?.reservationsDone ?? null,
    };
  }
}

/**
 * Contraparte falsa de `PatientMonthSyncRepository` (`anacare_patient_month` +
 * `anacare_patient_month_provider`, migrations 441/442, D361) — em memória, vida do processo.
 *
 * `ensureSeeded` (item 1 da revisão de PR, espelhado aqui na F6.2): sem pré-semeadura própria, o
 * controller que monta a LISTA em modo `ANACARE_HOURS_SOURCE=fake` sem o sync ter rodado receberia
 * `patients: []`. Conserto 17/09 (passo 3): antes semeava chamando `recomputeFromShifts` (método
 * apagado neste passo — nenhum caller de produção o usava, só esta seedagem de dev/e2e); agora
 * semeia direto com `aggregatePatientMonth` (mesma função pura que o runner usa) + a extração de
 * pares paciente×prestador, sem depender de nenhum método do contrato de produção.
 */
export class FakeAnaCarePatientMonthRepository implements PatientMonthSyncRepository {
  private readonly rows = new Map<string, AnaCarePatientMonthAggregate>();
  /** Nome do prestador por par paciente×prestador (migration 442, Adendo 17/09) — primeiro valor
   * não-vazio visto vence, nunca é apagado por uma rodada sem nome (mesma regra do SQL real). */
  private readonly providers = new Map<string, AnaCarePatientMonthProviderAggregate>();
  private readonly seededMonths = new Set<string>();
  private lastFetchedAt: string | null = null;
  /** Carimbo por linha (source::mês::paciente) — espelha a coluna `fetched_at` real, usado pelo
   * detector de colisão de `upsertReplacingForRun` (mesmo racional do SQL real). */
  private readonly fetchedAtByKey = new Map<string, Date>();

  private key(source: string, periodMonth: string, anaCarePatientId: string): string {
    return `${source}::${periodMonth}::${anaCarePatientId}`;
  }

  private providerKey(source: string, periodMonth: string, anaCarePatientId: string, anaCareNurseId: string): string {
    return `${source}::${periodMonth}::${anaCarePatientId}::${anaCareNurseId}`;
  }

  /** Grava os pares paciente×prestador do lote — mesma regra de `AnaCarePatientMonthRepository.upsertProvidersFromShifts`. */
  private writeProviders(shifts: readonly SourceShiftDTO[], periodMonth: string): void {
    for (const s of shifts) {
      const pk = this.providerKey('anacare', periodMonth, s.anaCarePatientId, s.anaCareNurseId);
      const existing = this.providers.get(pk);
      const firstName = nonEmpty(s.nurseFirstName) ?? existing?.nurseFirstName;
      const lastName = nonEmpty(s.nurseLastName) ?? existing?.nurseLastName;
      this.providers.set(pk, { anaCarePatientId: s.anaCarePatientId, anaCareNurseId: s.anaCareNurseId, nurseFirstName: firstName, nurseLastName: lastName });
    }
  }

  /** Mesmo racional de antes — seedagem própria de dev/e2e, não depende de nenhum método do contrato de produção. */
  private ensureSeeded(month: string): void {
    if (this.seededMonths.has(month)) return;
    this.seededMonths.add(month);
    const shifts = FakeAnaCareShiftsSource.generateMonth(month);
    if (shifts.length === 0) return;

    const byPatient = new Map<string, SourceShiftDTO[]>();
    for (const s of shifts) {
      if (!byPatient.has(s.anaCarePatientId)) byPatient.set(s.anaCarePatientId, []);
      byPatient.get(s.anaCarePatientId)!.push(s);
    }
    for (const [patientId, patientShifts] of byPatient) {
      const aggregate = aggregatePatientMonth(patientId, patientShifts);
      this.rows.set(this.key('anacare', month, patientId), aggregate);
    }
    this.writeProviders(shifts, month);
    this.lastFetchedAt = new Date().toISOString();
  }

  async upsertMany(aggregates: readonly AnaCarePatientMonthAggregate[], periodMonth: string): Promise<{ written: number }> {
    for (const a of aggregates) this.rows.set(this.key('anacare', periodMonth, a.anaCarePatientId), a);
    if (aggregates.length > 0) this.lastFetchedAt = new Date().toISOString();
    return { written: aggregates.length };
  }

  /** Ver contrato em `PatientMonthSyncRepository.upsertReplacingForRun` — mesma checagem do SQL real. */
  async upsertReplacingForRun(
    aggregates: readonly AnaCarePatientMonthAggregate[],
    periodMonth: string,
    runStartedAt: Date,
    shifts: readonly SourceShiftDTO[],
  ): Promise<{ written: number }> {
    if (aggregates.length === 0) return { written: 0 };

    const colliding = aggregates
      .map((a) => a.anaCarePatientId)
      .filter((id) => {
        const existing = this.fetchedAtByKey.get(this.key('anacare', periodMonth, id));
        return existing !== undefined && existing >= runStartedAt;
      });
    if (colliding.length > 0) {
      throw new AnaCarePatientMonthCollisionError(colliding, periodMonth);
    }

    const now = new Date();
    for (const a of aggregates) {
      const k = this.key('anacare', periodMonth, a.anaCarePatientId);
      this.rows.set(k, a);
      this.fetchedAtByKey.set(k, now);
    }
    if (shifts.length > 0) this.writeProviders(shifts, periodMonth);
    this.lastFetchedAt = now.toISOString();
    return { written: aggregates.length };
  }

  async listByMonth(source: string, periodMonth: string): Promise<AnaCarePatientMonthAggregate[]> {
    this.ensureSeeded(periodMonth);
    const prefix = `${source}::${periodMonth}::`;
    return [...this.rows.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
  }

  async listProvidersByMonth(source: string, periodMonth: string): Promise<AnaCarePatientMonthProviderAggregate[]> {
    this.ensureSeeded(periodMonth);
    const prefix = `${source}::${periodMonth}::`;
    return [...this.providers.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
  }

  async getSnapshotFreshness(source: string, periodMonth: string): Promise<ShiftSyncFreshness> {
    const rows = await this.listByMonth(source, periodMonth);
    return { shifts: rows.length, lastFetchedAt: rows.length > 0 ? this.lastFetchedAt : null };
  }
}
