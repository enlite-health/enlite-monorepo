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
import type {
  EnliteDirectorySnapshot,
  EnliteDirectorySource,
  PatientMonthSyncRepository,
  ShiftSyncFreshness,
  ShiftSyncRepository,
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

/** Em memória, vida do processo — nunca persiste entre reinícios (adequado só para dev/e2e local). */
export class FakeAnaCareShiftRepository implements ShiftSyncRepository {
  private readonly rows = new Map<string, SourceShiftDTO>();
  private readonly seededMonths = new Set<string>();
  private lastFetchedAt: string | null = null;
  private lastDirectoryCount: number | null = null;

  /**
   * Item 1 (revisão de PR): pré-semeia o mês com a MESMA massa sintética de
   * `FakeAnaCareShiftsSource` na primeira leitura. Sem isso este repositório era write-only — só o
   * sync (falso) escrevia nele — e a lista (que só lê daqui) nascia vazia em e2e que testam a
   * lista sem disparar sync antes. Idempotente por mês; se o sync (falso) rodar depois, o
   * `upsertMany` sobrescreve normalmente as mesmas chaves.
   */
  private ensureSeeded(month: string): void {
    if (this.seededMonths.has(month)) return;
    this.seededMonths.add(month);
    for (const s of FakeAnaCareShiftsSource.generateMonth(month)) {
      if (!this.rows.has(s.sourceShiftId)) this.rows.set(s.sourceShiftId, s);
    }
  }

  async upsertMany(shifts: readonly SourceShiftDTO[], _periodMonth: string): Promise<{ written: number }> {
    for (const s of shifts) this.rows.set(s.sourceShiftId, s);
    if (shifts.length > 0) this.lastFetchedAt = new Date().toISOString();
    return { written: shifts.length };
  }

  async listByMonth(month: string, patientId?: string): Promise<SourceShiftDTO[]> {
    this.ensureSeeded(month);
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

/**
 * Contraparte falsa de `PatientMonthSyncRepository` (`anacare_patient_month` +
 * `anacare_patient_month_provider`, migrations 441/442, D361) — em memória, vida do processo,
 * mesmo racional de `FakeAnaCareShiftRepository`.
 *
 * `ensureSeeded` (item 1 da revisão de PR, espelhado aqui na F6.2): sem pré-semeadura própria, o
 * controller que monta a LISTA em modo `ANACARE_HOURS_SOURCE=fake` sem o sync ter rodado receberia
 * `patients: []` — a F6.2 troca a LEITURA da lista para este repositório (antes lia
 * `FakeAnaCareShiftRepository`, que já tinha a mesma pré-semeadura), então o mesmo comportamento
 * precisa valer aqui: primeira leitura do mês gera a massa sintética e roda `recomputeFromShifts`
 * como o sync (falso) faria.
 */
export class FakeAnaCarePatientMonthRepository implements PatientMonthSyncRepository {
  private readonly rows = new Map<string, AnaCarePatientMonthAggregate>();
  /** Turnos acumulados por chave (source::mês::paciente) — espelha `anacare_shift` na versão real:
   * `recomputeFromShifts` NUNCA soma só o lote atual, sempre recomputa sobre TUDO que já viu para
   * aquele paciente/mês (mesmo bug que o `upsertMany` por-reserva tinha, evitado aqui do mesmo jeito
   * que o SQL real evita: lendo a fonte cumulativa, não sobrescrevendo com o lote isolado). */
  private readonly shiftsByKey = new Map<string, SourceShiftDTO[]>();
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

  /** Mesmo racional de `FakeAnaCareShiftRepository.ensureSeeded` — ver cabeçalho da classe. */
  private ensureSeeded(month: string): void {
    if (this.seededMonths.has(month)) return;
    this.seededMonths.add(month);
    const shifts = FakeAnaCareShiftsSource.generateMonth(month);
    if (shifts.length > 0) void this.recomputeFromShifts(shifts, month);
  }

  async upsertMany(aggregates: readonly AnaCarePatientMonthAggregate[], periodMonth: string): Promise<{ written: number }> {
    for (const a of aggregates) this.rows.set(this.key('anacare', periodMonth, a.anaCarePatientId), a);
    if (aggregates.length > 0) this.lastFetchedAt = new Date().toISOString();
    return { written: aggregates.length };
  }

  async recomputeFromShifts(shifts: readonly SourceShiftDTO[], periodMonth: string): Promise<{ written: number }> {
    if (shifts.length === 0) return { written: 0 };
    const patientIds = new Set<string>();
    for (const s of shifts) {
      patientIds.add(s.anaCarePatientId);
      const k = this.key('anacare', periodMonth, s.anaCarePatientId);
      if (!this.shiftsByKey.has(k)) this.shiftsByKey.set(k, []);
      this.shiftsByKey.get(k)!.push(s);

      // Par paciente×prestador (migration 442) — só os pares deste lote, nunca apaga um já gravado.
      const pk = this.providerKey('anacare', periodMonth, s.anaCarePatientId, s.anaCareNurseId);
      const existing = this.providers.get(pk);
      const firstName = nonEmpty(s.nurseFirstName) ?? existing?.nurseFirstName;
      const lastName = nonEmpty(s.nurseLastName) ?? existing?.nurseLastName;
      this.providers.set(pk, { anaCarePatientId: s.anaCarePatientId, anaCareNurseId: s.anaCareNurseId, nurseFirstName: firstName, nurseLastName: lastName });
    }
    for (const patientId of patientIds) {
      const k = this.key('anacare', periodMonth, patientId);
      const aggregate = aggregatePatientMonth(patientId, this.shiftsByKey.get(k)!);
      this.rows.set(k, aggregate);
    }
    this.lastFetchedAt = new Date().toISOString();
    return { written: patientIds.size };
  }

  /** Ver contrato em `PatientMonthSyncRepository.upsertReplacingForRun` — mesma checagem do SQL real. */
  async upsertReplacingForRun(
    aggregates: readonly AnaCarePatientMonthAggregate[],
    periodMonth: string,
    runStartedAt: Date,
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
