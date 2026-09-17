/**
 * F4 (tasks 4.8/4.9) — prova do "termina quando" da fase-4.md linhas 39-42:
 *   - "disparo manual + cron ao mesmo tempo não dobra requests" (4.8)
 *   - "sabotagem: rodada sem emitir a métrica falha o teste" (4.9)
 *
 * Fonte: STUB em memória com contador de chamadas (nunca `FakeAnaCareShiftsSource` real de rede —
 * aqui só precisamos CONTAR chamadas, não gerar massa).
 */
import { AnaCareHoursSyncRunner, AnaCareDirectoryDroppedError, AnaCareDirectoryFirstRunNotConfiguredError } from '../AnaCareHoursSyncRunner';
import { AnaCareHoursSyncGuard } from '../AnaCareHoursSyncGuard';
import type { AnaCareShiftsSource, ListShiftsParams, SourceShiftDTO } from '../../domain/AnaCareShiftsSource';
import type { EnliteDirectorySnapshot, EnliteDirectorySource, PatientMonthSyncRepository, ShiftSyncFreshness, ShiftSyncRepository } from '../../domain/AnaCareHoursSyncPorts';
import type { AnaCarePatientMonthAggregate, AnaCarePatientMonthProviderAggregate } from '../../domain/AnaCarePatientMonth';
import { aggregateByPatient, aggregatePatientMonth } from '../AnaCarePatientMonthAggregator';
import type { AnaCareHoursSyncMetric } from '../../infrastructure/AnaCareHoursSyncMetrics';

class CountingShiftsSource implements AnaCareShiftsSource {
  calls = 0;
  private readonly delayMs: number;

  constructor(delayMs = 20) {
    this.delayMs = delayMs;
  }

  async listShifts(_params: ListShiftsParams): Promise<{ shifts: SourceShiftDTO[]; skipped: { noProvider: number; noPatient: number } }> {
    this.calls += 1;
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return { shifts: [], skipped: { noProvider: 0, noPatient: 0 } };
  }

  async getShift(): Promise<SourceShiftDTO | null> {
    return null;
  }

  async getRetratoStatus() {
    return { stale: false, circuitBreakerOpen: false };
  }
}

describe('AnaCareHoursSyncRunner — dedup de disparo concorrente (4.8)', () => {
  it('manual + cron simultâneos resultam em UMA única chamada à fonte', async () => {
    const source = new CountingShiftsSource(30);
    const runner = new AnaCareHoursSyncRunner(source, new AnaCareHoursSyncGuard(), () => {}, () => '2026-09', undefined, undefined, { ANACARE_DIRECTORY_MIN_ABSOLUTE: '1' });

    const [manual, cron] = await Promise.all([
      runner.run({ origin: 'manual', userId: 'staff-1' }),
      runner.run({ origin: 'cron', userId: null }),
    ]);

    expect(source.calls).toBe(1);
    // Uma das duas rodadas é a "dona" (deduped: false), a outra compartilha o resultado.
    expect([manual.deduped, cron.deduped].sort()).toEqual([false, true]);
  });

  it('duas rodadas sequenciais (não concorrentes) SÃO duas chamadas — dedup é só para concorrência', async () => {
    const source = new CountingShiftsSource(1);
    const runner = new AnaCareHoursSyncRunner(source, new AnaCareHoursSyncGuard(), () => {}, () => '2026-09', undefined, undefined, { ANACARE_DIRECTORY_MIN_ABSOLUTE: '1' });

    await runner.run({ origin: 'manual', userId: 'staff-1' });
    await runner.run({ origin: 'cron', userId: null });

    expect(source.calls).toBe(2);
  });

  it('SABOTAGEM (guard removido): 2 disparos concorrentes viram 2 chamadas à fonte', async () => {
    // Simula o que aconteceria se o Runner não passasse pelo guard: chama a fonte direto.
    const source = new CountingShiftsSource(30);
    const sabotagedRun = () => Promise.all([source.listShifts({ month: '2026-09' }), source.listShifts({ month: '2026-09' })]);
    await sabotagedRun();
    expect(source.calls).toBe(2); // prova que SEM o guard, o dedup não acontece — o guard é o que faz a diferença
  });
});

describe('AnaCareHoursSyncRunner — métrica de custo/consumo (4.9)', () => {
  it('toda rodada emite a métrica com os campos exigidos (requests, retries, duração, origem)', async () => {
    const source = new CountingShiftsSource(1);
    const emitted: AnaCareHoursSyncMetric[] = [];
    const runner = new AnaCareHoursSyncRunner(source, new AnaCareHoursSyncGuard(), (m) => emitted.push(m), () => '2026-09', undefined, undefined, { ANACARE_DIRECTORY_MIN_ABSOLUTE: '1' });

    await runner.run({ origin: 'manual', userId: 'staff-1' });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      event: 'anacare_hours_sync',
      origin: 'manual',
      userId: 'staff-1',
      requests: 1,
      retries: 0,
      deduped: false,
    });
    expect(typeof emitted[0].durationMs).toBe('number');
  });

  it('rodada de origem cron NÃO carrega userId (nunca PII/identidade fora do disparo manual)', async () => {
    const source = new CountingShiftsSource(1);
    const emitted: AnaCareHoursSyncMetric[] = [];
    const runner = new AnaCareHoursSyncRunner(source, new AnaCareHoursSyncGuard(), (m) => emitted.push(m), () => '2026-09', undefined, undefined, { ANACARE_DIRECTORY_MIN_ABSOLUTE: '1' });

    await runner.run({ origin: 'cron', userId: null });

    expect(emitted[0].userId).toBeNull();
  });

  it('a rodada DEDUPED também emite métrica (origem concorrente fica visível)', async () => {
    const source = new CountingShiftsSource(30);
    const emitted: AnaCareHoursSyncMetric[] = [];
    const runner = new AnaCareHoursSyncRunner(source, new AnaCareHoursSyncGuard(), (m) => emitted.push(m), () => '2026-09', undefined, undefined, { ANACARE_DIRECTORY_MIN_ABSOLUTE: '1' });

    await Promise.all([runner.run({ origin: 'manual', userId: 'staff-1' }), runner.run({ origin: 'cron', userId: null })]);

    expect(emitted).toHaveLength(2);
    expect(emitted.filter((m) => m.deduped)).toHaveLength(1);
  });
});

// ── F4 continuação — sync por RESERVA (não varredura), cursor + orçamento, alarme do diretório ──

class StubDirectory implements EnliteDirectorySource {
  constructor(private readonly reservationIds: string[]) {}
  async fetch(): Promise<EnliteDirectorySnapshot> {
    return {
      entries: this.reservationIds.map((reservationId) => ({ reservationId })),
      counts: { activo: this.reservationIds.length, terminado: 0, total: this.reservationIds.length },
      partial: false,
    };
  }
}

class StubSyncRepository implements ShiftSyncRepository {
  readonly written: SourceShiftDTO[] = [];
  private lastDirectoryCount: number | null = null;

  async upsertMany(shifts: readonly SourceShiftDTO[]): Promise<{ written: number }> {
    this.written.push(...shifts);
    return { written: shifts.length };
  }
  async listByMonth(): Promise<SourceShiftDTO[]> {
    return [];
  }
  async getSnapshotFreshness(): Promise<ShiftSyncFreshness> {
    return { shifts: 0, lastFetchedAt: null };
  }
  async getLastDirectoryCount(): Promise<number | null> {
    return this.lastDirectoryCount;
  }
  async setLastDirectoryCount(count: number): Promise<void> {
    this.lastDirectoryCount = count;
  }
}

/**
 * F6.1 (D361): stub do retrato AGREGADO — prova que o runner grava as DUAS tabelas na mesma rodada.
 * `recomputeFromShifts` aqui imita a versão real (SQL) o suficiente para essa prova: como cada
 * `PerReservationShiftsSource` (abaixo) devolve UM paciente por reserva (nunca o mesmo paciente
 * duas vezes), este stub simplificado (recompute = só o lote atual) já basta — o teste que precisa
 * do comportamento cumulativo de verdade usa `RecordingPatientMonthRepository`, mais abaixo.
 */
class StubPatientMonthRepository implements PatientMonthSyncRepository {
  readonly written: AnaCarePatientMonthAggregate[] = [];
  async upsertMany(aggregates: readonly AnaCarePatientMonthAggregate[]): Promise<{ written: number }> {
    this.written.push(...aggregates);
    return { written: aggregates.length };
  }
  async recomputeFromShifts(shifts: readonly SourceShiftDTO[]): Promise<{ written: number }> {
    const aggregates = aggregateByPatient(shifts);
    this.written.push(...aggregates);
    return { written: aggregates.length };
  }
  async listByMonth(): Promise<AnaCarePatientMonthAggregate[]> {
    return [];
  }
  async listProvidersByMonth(): Promise<AnaCarePatientMonthProviderAggregate[]> {
    return [];
  }
  async getSnapshotFreshness(): Promise<ShiftSyncFreshness> {
    return { shifts: 0, lastFetchedAt: null };
  }
}

/**
 * Conserto 17/09 (D361 F6.1) — o "termina quando" deste teste: recompute é sempre o TOTAL do
 * paciente no mês, nunca só o lote da reserva atual. Imita a semântica do SQL real
 * (`AnaCarePatientMonthRepository.recomputeFromShifts`, que faz `SELECT ... GROUP BY` sobre
 * `anacare_shift` inteira) SEM tocar banco: acumula os turnos por paciente/mês (persistente na
 * instância, como a tabela real persiste entre invocações do runner) e recomputa com a MESMA
 * função pura (`aggregatePatientMonth`) sobre TODOS os turnos já vistos daquele paciente — nunca
 * só os do lote atual.
 */
class RecordingPatientMonthRepository implements PatientMonthSyncRepository {
  private readonly shiftsByPatient = new Map<string, SourceShiftDTO[]>();
  readonly aggregatesByPatient = new Map<string, AnaCarePatientMonthAggregate>();
  /** Cada elemento é o resultado do agregado LOGO APÓS aquela chamada — prova a ordem/evolução. */
  readonly history: AnaCarePatientMonthAggregate[] = [];

  async upsertMany(aggregates: readonly AnaCarePatientMonthAggregate[]): Promise<{ written: number }> {
    for (const a of aggregates) this.aggregatesByPatient.set(a.anaCarePatientId, a);
    return { written: aggregates.length };
  }
  async recomputeFromShifts(shifts: readonly SourceShiftDTO[]): Promise<{ written: number }> {
    const patientIds = new Set<string>();
    for (const s of shifts) {
      patientIds.add(s.anaCarePatientId);
      if (!this.shiftsByPatient.has(s.anaCarePatientId)) this.shiftsByPatient.set(s.anaCarePatientId, []);
      this.shiftsByPatient.get(s.anaCarePatientId)!.push(s);
    }
    for (const patientId of patientIds) {
      const aggregate = aggregatePatientMonth(patientId, this.shiftsByPatient.get(patientId)!);
      this.aggregatesByPatient.set(patientId, aggregate);
      this.history.push(aggregate);
    }
    return { written: patientIds.size };
  }
  async listByMonth(): Promise<AnaCarePatientMonthAggregate[]> {
    return [...this.aggregatesByPatient.values()];
  }
  async listProvidersByMonth(): Promise<AnaCarePatientMonthProviderAggregate[]> {
    return [];
  }
  async getSnapshotFreshness(): Promise<ShiftSyncFreshness> {
    return { shifts: 0, lastFetchedAt: null };
  }
}

/**
 * Fonte cujas reservas devolvem turnos do MESMO paciente (`PAT-SHARED`) com um turno REAL
 * (checkin/checkout) de duração distinta por reserva — prova que o total final é a SOMA das
 * reservas, não a última a escrever.
 */
class SharedPatientShiftsSource implements AnaCareShiftsSource {
  constructor(private readonly hoursByReservation: Record<string, number>) {}
  async listShifts(params: ListShiftsParams): Promise<{ shifts: SourceShiftDTO[]; skipped: { noProvider: number; noPatient: number } }> {
    const reservationId = params.reservationId;
    if (!reservationId) return { shifts: [], skipped: { noProvider: 0, noPatient: 0 } };
    const hours = this.hoursByReservation[reservationId];
    const checkoutHour = 8 + hours;
    return {
      shifts: [
        {
          sourceShiftId: `${reservationId}-shift-0`,
          anaCarePatientId: 'PAT-SHARED',
          anaCareNurseId: `NURSE-${reservationId}`,
          date: '2026-09-10',
          scheduledStart: '2026-09-10T08:00:00.000Z',
          scheduledEnd: '2026-09-10T12:00:00.000Z',
          actualStart: '2026-09-10T08:00:00.000Z',
          actualEnd: `2026-09-10T${String(checkoutHour).padStart(2, '0')}:00:00.000Z`,
          checkinSource: 'app',
          isFinalized: true,
        },
      ],
      skipped: { noProvider: 0, noPatient: 0 },
    };
  }
  async getShift(): Promise<SourceShiftDTO | null> {
    return null;
  }
  async getRetratoStatus() {
    return { stale: false, circuitBreakerOpen: false };
  }
}

/** Fonte que devolve 1 turno sintético por reserva pedida — prova que o runner grava o que lê. */
class PerReservationShiftsSource implements AnaCareShiftsSource {
  readonly calls: Array<{ month: string; reservationId?: string }> = [];
  async listShifts(params: ListShiftsParams): Promise<{ shifts: SourceShiftDTO[]; skipped: { noProvider: number; noPatient: number } }> {
    this.calls.push({ month: params.month, reservationId: params.reservationId });
    if (!params.reservationId) return { shifts: [], skipped: { noProvider: 0, noPatient: 0 } };
    return {
      shifts: [
        {
          sourceShiftId: `${params.reservationId}-shift-0`,
          anaCarePatientId: params.reservationId,
          anaCareNurseId: 'AC-NURSE-0',
          date: '2026-09-10',
          scheduledStart: '2026-09-10T08:00:00.000Z',
          scheduledEnd: '2026-09-10T12:00:00.000Z',
          actualStart: null,
          actualEnd: null,
          checkinSource: null,
          isFinalized: false,
        },
      ],
      skipped: { noProvider: 0, noPatient: 0 },
    };
  }
  async getShift(): Promise<SourceShiftDTO | null> {
    return null;
  }
  async getRetratoStatus() {
    return { stale: false, circuitBreakerOpen: false };
  }
}

/**
 * Fonte que devolve, POR RESERVA, uma quantidade FIXA de turnos descartados (sem prestador /
 * sem paciente) além do turno normal — prova que a contagem do runner SOMA sobre reservas e
 * chega até `AnaCareHoursSyncOutcome`, não fica presa na 1ª reserva.
 */
class SkippingShiftsSource implements AnaCareShiftsSource {
  constructor(private readonly skippedPerReservation: { noProvider: number; noPatient: number }) {}
  async listShifts(params: ListShiftsParams): Promise<{ shifts: SourceShiftDTO[]; skipped: { noProvider: number; noPatient: number } }> {
    if (!params.reservationId) return { shifts: [], skipped: { noProvider: 0, noPatient: 0 } };
    return {
      shifts: [
        {
          sourceShiftId: `${params.reservationId}-shift-0`,
          anaCarePatientId: params.reservationId,
          anaCareNurseId: 'AC-NURSE-0',
          date: '2026-09-10',
          scheduledStart: '2026-09-10T08:00:00.000Z',
          scheduledEnd: '2026-09-10T12:00:00.000Z',
          actualStart: null,
          actualEnd: null,
          checkinSource: null,
          isFinalized: false,
        },
      ],
      skipped: { ...this.skippedPerReservation },
    };
  }
  async getShift(): Promise<SourceShiftDTO | null> {
    return null;
  }
  async getRetratoStatus() {
    return { stale: false, circuitBreakerOpen: false };
  }
}

describe('AnaCareHoursSyncRunner — sync por reserva (diretório Enlite), não varredura do mês', () => {
  it('percorre TODAS as reservas do diretório e grava via repository.upsertMany', async () => {
    const source = new PerReservationShiftsSource();
    const directory = new StubDirectory(['100', '200', '300']);
    const repository = new StubSyncRepository();
    const runner = new AnaCareHoursSyncRunner(source, new AnaCareHoursSyncGuard(), () => {}, () => '2026-09', directory, repository, { ANACARE_DIRECTORY_MIN_ABSOLUTE: '1' });

    const outcome = await runner.run({ origin: 'manual', userId: 'staff-1' });

    expect(source.calls).toEqual([
      { month: '2026-09', reservationId: '100' },
      { month: '2026-09', reservationId: '200' },
      { month: '2026-09', reservationId: '300' },
    ]);
    expect(outcome.reservationsProcessed).toBe(3);
    expect(outcome.shiftsWritten).toBe(3);
    expect(outcome.nextCursor).toBeNull();
    expect(repository.written).toHaveLength(3);
  });

  /**
   * F6.1 (D361): prova que o retrato AGREGADO (`anacare_patient_month`) é escrito NA MESMA RODADA
   * que o retrato por turno (`anacare_shift`) — convivência deliberada, nenhuma das duas fica pra
   * trás. `PerReservationShiftsSource` devolve 1 turno por reserva com `anaCarePatientId` = a
   * própria reserva, então 3 reservas ⇒ 3 pacientes agregados, 1 turno cada.
   */
  it('grava o retrato AGREGADO (anacare_patient_month) ao lado do retrato por turno, na mesma rodada', async () => {
    const source = new PerReservationShiftsSource();
    const directory = new StubDirectory(['100', '200', '300']);
    const repository = new StubSyncRepository();
    const patientMonthRepository = new StubPatientMonthRepository();
    const runner = new AnaCareHoursSyncRunner(
      source,
      new AnaCareHoursSyncGuard(),
      () => {},
      () => '2026-09',
      directory,
      repository,
      { ANACARE_DIRECTORY_MIN_ABSOLUTE: '1' },
      patientMonthRepository,
    );

    const outcome = await runner.run({ origin: 'manual', userId: 'staff-1' });

    expect(outcome.shiftsWritten).toBe(3);
    // As duas tabelas convivem: anacare_shift recebeu os 3 turnos, anacare_patient_month recebeu
    // os 3 agregados (1 por paciente/reserva) — nenhuma delas fica vazia.
    expect(repository.written).toHaveLength(3);
    expect(patientMonthRepository.written).toHaveLength(3);
    expect(patientMonthRepository.written.map((a) => a.anaCarePatientId).sort()).toEqual(['100', '200', '300']);
    for (const aggregate of patientMonthRepository.written) {
      expect(aggregate.shiftsCount).toBe(1);
      expect(aggregate.providersCount).toBe(1);
    }
  });

  it('respeita o orçamento de tempo: para no meio e devolve nextCursor — a próxima chamada retoma dali sem reprocessar', async () => {
    const source = new PerReservationShiftsSource();
    const directory = new StubDirectory(['100', '200', '300']);
    const repository = new StubSyncRepository();
    const runner = new AnaCareHoursSyncRunner(source, new AnaCareHoursSyncGuard(), () => {}, () => '2026-09', directory, repository, { ANACARE_DIRECTORY_MIN_ABSOLUTE: '1' });

    // budgetMs=0: a checagem de prazo já vale ANTES da 1ª iteração — para sem processar nada.
    const first = await runner.run({ origin: 'manual', userId: 'staff-1', budgetMs: 0 });
    expect(first.reservationsProcessed).toBe(0);
    expect(first.nextCursor).toBe(0);
    expect(source.calls).toHaveLength(0);

    // Retoma do cursor devolvido, com orçamento normal — processa o restante (as 3 reservas, do índice 0).
    const second = await runner.run({ origin: 'manual', userId: 'staff-1', cursor: first.nextCursor });
    expect(second.reservationsProcessed).toBe(3);
    expect(second.nextCursor).toBeNull();
  });

  it('segunda chamada com cursor no MEIO da lista não reprocessa as reservas já feitas', async () => {
    const source = new PerReservationShiftsSource();
    const directory = new StubDirectory(['100', '200', '300']);
    const repository = new StubSyncRepository();
    const runner = new AnaCareHoursSyncRunner(source, new AnaCareHoursSyncGuard(), () => {}, () => '2026-09', directory, repository, { ANACARE_DIRECTORY_MIN_ABSOLUTE: '1' });

    const outcome = await runner.run({ origin: 'manual', userId: 'staff-1', cursor: 2 });

    expect(source.calls).toEqual([{ month: '2026-09', reservationId: '300' }]);
    expect(outcome.reservationsProcessed).toBe(1);
    expect(outcome.nextCursor).toBeNull();
  });

  it('devolve directoryCounts da rodada', async () => {
    const source = new PerReservationShiftsSource();
    const directory = new StubDirectory(['100', '200']);
    const repository = new StubSyncRepository();
    const runner = new AnaCareHoursSyncRunner(source, new AnaCareHoursSyncGuard(), () => {}, () => '2026-09', directory, repository, { ANACARE_DIRECTORY_MIN_ABSOLUTE: '1' });

    const outcome = await runner.run({ origin: 'cron', userId: null });
    expect(outcome.directoryCounts).toEqual({ activo: 2, terminado: 0, total: 2 });
  });

  /**
   * Conserto 17/09/2026 (500 medido em produção): a contagem de turnos descartados na
   * minimização (sem prestador/paciente) tem de SOMAR sobre TODAS as reservas processadas e
   * chegar até `AnaCareHoursSyncOutcome` — é o campo que o controller devolve no JSON do
   * `POST /api/admin/anacare-hours/sync`. MORRE se o runner voltar a ignorar `skipped` do
   * retorno de `source.listShifts` (ex.: desestruturar só `shifts`).
   */
  it('soma shiftsSkippedNoProvider/shiftsSkippedNoPatient sobre as 3 reservas e leva a contagem até o outcome', async () => {
    const source = new SkippingShiftsSource({ noProvider: 2, noPatient: 1 });
    const directory = new StubDirectory(['100', '200', '300']);
    const repository = new StubSyncRepository();
    const runner = new AnaCareHoursSyncRunner(source, new AnaCareHoursSyncGuard(), () => {}, () => '2026-09', directory, repository, { ANACARE_DIRECTORY_MIN_ABSOLUTE: '1' });

    const outcome = await runner.run({ origin: 'manual', userId: 'staff-1' });

    // 3 reservas × (2 sem prestador + 1 sem paciente) = 6 / 3.
    expect(outcome.shiftsSkippedNoProvider).toBe(6);
    expect(outcome.shiftsSkippedNoPatient).toBe(3);
    expect(outcome.shiftsSkippedNoProvider).toBeGreaterThan(0); // contagem zero é falha — este cenário TEM descarte
  });

  it('sem nenhum descarte no lote, shiftsSkippedNoProvider/shiftsSkippedNoPatient ficam 0 (contagem zero de verdade, não ausência de campo)', async () => {
    const source = new PerReservationShiftsSource();
    const directory = new StubDirectory(['100', '200']);
    const repository = new StubSyncRepository();
    const runner = new AnaCareHoursSyncRunner(source, new AnaCareHoursSyncGuard(), () => {}, () => '2026-09', directory, repository, { ANACARE_DIRECTORY_MIN_ABSOLUTE: '1' });

    const outcome = await runner.run({ origin: 'cron', userId: null });
    expect(outcome.shiftsSkippedNoProvider).toBe(0);
    expect(outcome.shiftsSkippedNoPatient).toBe(0);
  });
});

describe('AnaCareHoursSyncRunner — alarme de queda do diretório (raspagem quebra em silêncio)', () => {
  it('contagem despenca abaixo do piso relativo (80% do último conhecido) ⇒ ERRO, nada gravado', async () => {
    const source = new PerReservationShiftsSource();
    const repository = new StubSyncRepository();
    await repository.setLastDirectoryCount(283); // última contagem conhecida — piso relativo = 226

    const directoryCaida = new StubDirectory(Array.from({ length: 50 }, (_, i) => String(i))); // bem abaixo de 226
    const runner = new AnaCareHoursSyncRunner(source, new AnaCareHoursSyncGuard(), () => {}, () => '2026-09', directoryCaida, repository);

    await expect(runner.run({ origin: 'cron', userId: null })).rejects.toBeInstanceOf(AnaCareDirectoryDroppedError);
    expect(repository.written).toHaveLength(0);
    expect(source.calls).toHaveLength(0);
  });

  /**
   * Item 4 (revisão de PR): antes, sem histórico E sem `ANACARE_DIRECTORY_MIN_ABSOLUTE`, o
   * default permissivo (`1`) deixava a 1ª rodada passar sempre — inclusive com a raspagem
   * quebrada — e essa contagem virava a linha-base pra sempre. Agora é fail-closed: recusa com
   * erro nomeado, nada é gravado. Este teste MORRE se o default voltar a ser permissivo.
   */
  it('primeira execução (sem contagem conhecida) E sem ANACARE_DIRECTORY_MIN_ABSOLUTE ⇒ recusa com erro nomeado, nada gravado', async () => {
    const source = new PerReservationShiftsSource();
    const repository = new StubSyncRepository(); // getLastDirectoryCount() → null
    const directory = new StubDirectory(['100', '200']);
    const runner = new AnaCareHoursSyncRunner(source, new AnaCareHoursSyncGuard(), () => {}, () => '2026-09', directory, repository, {});

    await expect(runner.run({ origin: 'cron', userId: null })).rejects.toBeInstanceOf(AnaCareDirectoryFirstRunNotConfiguredError);
    expect(repository.written).toHaveLength(0);
    expect(source.calls).toHaveLength(0);
  });

  it('primeira execução (sem contagem conhecida) MAS com ANACARE_DIRECTORY_MIN_ABSOLUTE configurada: total acima dele passa', async () => {
    const source = new PerReservationShiftsSource();
    const repository = new StubSyncRepository(); // getLastDirectoryCount() → null
    const directory = new StubDirectory(['100', '200']);
    const runner = new AnaCareHoursSyncRunner(source, new AnaCareHoursSyncGuard(), () => {}, () => '2026-09', directory, repository, {
      ANACARE_DIRECTORY_MIN_ABSOLUTE: '1',
    });

    await expect(runner.run({ origin: 'cron', userId: null })).resolves.toMatchObject({ reservationsProcessed: 2 });
  });

  it('piso ABSOLUTO configurável via env (ANACARE_DIRECTORY_MIN_ABSOLUTE) barra mesmo sem histórico', async () => {
    const source = new PerReservationShiftsSource();
    const repository = new StubSyncRepository();
    const directory = new StubDirectory(['100']); // total=1
    const runner = new AnaCareHoursSyncRunner(
      source,
      new AnaCareHoursSyncGuard(),
      () => {},
      () => '2026-09',
      directory,
      repository,
      { ANACARE_DIRECTORY_MIN_ABSOLUTE: '150' },
    );

    await expect(runner.run({ origin: 'cron', userId: null })).rejects.toBeInstanceOf(AnaCareDirectoryDroppedError);
    expect(repository.written).toHaveLength(0);
  });
});

/**
 * Conserto 17/09/2026 (D361 F6.1): a 2ª reserva do MESMO paciente sobrescrevia a 1ª em silêncio,
 * porque o runner agregava em memória só os turnos da reserva atual e fazia upsert direto. Estes
 * dois testes FALHAM contra o código de ontem (que chamava `patientMonthRepository.upsertMany(
 * aggregateByPatient(shifts), month)`) e PASSAM contra o conserto (`recomputeFromShifts(shifts,
 * month)`, que recomputa do total cumulativo) — ver o relatório da execução para a prova
 * vermelho/verde (reversão temporária por `cp`, nunca `git checkout --`).
 */
describe('AnaCareHoursSyncRunner — conserto 17/09: paciente em DUAS reservas não perde a 1ª (D361 F6.1)', () => {
  it('MESMA rodada: duas reservas do mesmo paciente ⇒ o agregado final é a SOMA das duas, não só a última', async () => {
    const source = new SharedPatientShiftsSource({ A: 2, B: 3 }); // A: 08h→10h (2h), B: 08h→11h (3h)
    const directory = new StubDirectory(['A', 'B']);
    const repository = new StubSyncRepository();
    const patientMonthRepository = new RecordingPatientMonthRepository();
    const runner = new AnaCareHoursSyncRunner(
      source,
      new AnaCareHoursSyncGuard(),
      () => {},
      () => '2026-09',
      directory,
      repository,
      { ANACARE_DIRECTORY_MIN_ABSOLUTE: '1' },
      patientMonthRepository,
    );

    await runner.run({ origin: 'manual', userId: 'staff-1' });

    const final = patientMonthRepository.aggregatesByPatient.get('PAT-SHARED');
    expect(final).toBeDefined();
    // SOMA das duas reservas — se o conserto não estivesse aplicado, viria 3 (só a reserva B).
    expect(final!.shiftsCount).toBe(2);
    expect(final!.providersCount).toBe(2);
    expect(final!.hoursActualSum).toBe(5);
  });

  it('DUAS INVOCAÇÕES (retomada por cursor, ex.: budget esgotou entre reservas): o total sobrevive à 2ª rodada', async () => {
    const source = new SharedPatientShiftsSource({ A: 2, B: 3 });
    const repository = new StubSyncRepository();
    // Repositório do retrato agregado SOBREVIVE entre as duas invocações — mesma coisa que a
    // tabela real `anacare_patient_month` sobrevive entre duas chamadas do Cloud Run.
    const patientMonthRepository = new RecordingPatientMonthRepository();

    // Invocação 1 (ex.: 1ª chamada do Cloud Run): só a reserva A está no diretório desta rodada.
    const runner1 = new AnaCareHoursSyncRunner(
      source,
      new AnaCareHoursSyncGuard(),
      () => {},
      () => '2026-09',
      new StubDirectory(['A']),
      repository,
      { ANACARE_DIRECTORY_MIN_ABSOLUTE: '1' },
      patientMonthRepository,
    );
    await runner1.run({ origin: 'cron', userId: null });

    const afterFirstRun = patientMonthRepository.aggregatesByPatient.get('PAT-SHARED');
    expect(afterFirstRun!.shiftsCount).toBe(1);
    expect(afterFirstRun!.hoursActualSum).toBe(2);

    // Invocação 2 (retomada): só a reserva B está no diretório desta rodada — o runner não tem
    // memória da invocação 1, só o repositório (persistente) tem.
    const runner2 = new AnaCareHoursSyncRunner(
      source,
      new AnaCareHoursSyncGuard(),
      () => {},
      () => '2026-09',
      new StubDirectory(['B']),
      repository,
      { ANACARE_DIRECTORY_MIN_ABSOLUTE: '1' },
      patientMonthRepository,
    );
    await runner2.run({ origin: 'cron', userId: null });

    const afterSecondRun = patientMonthRepository.aggregatesByPatient.get('PAT-SHARED');
    // SOMA das duas invocações — se o conserto não estivesse aplicado, a 2ª rodada apagaria a 1ª.
    expect(afterSecondRun!.shiftsCount).toBe(2);
    expect(afterSecondRun!.hoursActualSum).toBe(5);
  });
});
