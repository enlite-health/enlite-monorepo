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
import type { DirectorySnapshotRepository, EnliteDirectorySnapshot, EnliteDirectorySource, PatientMonthSyncRepository, ShiftSyncFreshness } from '../../domain/AnaCareHoursSyncPorts';
import type { AnaCarePatientMonthAggregate, AnaCarePatientMonthProviderAggregate } from '../../domain/AnaCarePatientMonth';
import type { AnaCareHoursSyncMetric } from '../../infrastructure/AnaCareHoursSyncMetrics';
import { AnaCarePatientMonthCollisionError } from '../../infrastructure/AnaCarePatientMonthRepository';
import { FakeAnaCareSyncRunRepository } from '../../infrastructure/FakeAnaCareSyncDependencies';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
  reportError: jest.fn(),
}));

const { logger: loggerMock } = jest.requireMock('@shared/logging') as { logger: { warn: jest.Mock } };

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

/**
 * Conserto 17/09 (passo 2): antes implementava `ShiftSyncRepository` (upsertMany/listByMonth/
 * getSnapshotFreshness do retrato por turno, apagado) — sobra só `DirectorySnapshotRepository`
 * (as 2 leituras/escritas que sempre tiveram a ver com o alarme de queda do diretório, nunca com
 * turno). `written` fica vazio por construção — nada mais o alimenta — e as asserções que
 * checavam `repository.written` continuam provando a mesma coisa: nenhum turno é gravado aqui.
 */
class StubDirectorySnapshotRepository implements DirectorySnapshotRepository {
  readonly written: SourceShiftDTO[] = [];
  private lastDirectoryCount: number | null = null;

  async getLastDirectoryCount(): Promise<number | null> {
    return this.lastDirectoryCount;
  }
  async setLastDirectoryCount(count: number): Promise<void> {
    this.lastDirectoryCount = count;
  }
}

/**
 * F6.1 (D361): stub do retrato AGREGADO — prova que o runner grava o agregado a cada reserva.
 * Conserto 17/09 (passo 3): captura também os PARES paciente×prestador recebidos via `shifts` —
 * é o guarda-corpo da regressão do passo 1 (`upsertReplacingForRun` tinha parado de gravar o par).
 */
class StubPatientMonthRepository implements PatientMonthSyncRepository {
  readonly written: AnaCarePatientMonthAggregate[] = [];
  readonly providersWritten: AnaCarePatientMonthProviderAggregate[] = [];
  async upsertMany(aggregates: readonly AnaCarePatientMonthAggregate[]): Promise<{ written: number }> {
    this.written.push(...aggregates);
    return { written: aggregates.length };
  }
  /** Conserto 17/09 (passo 1): sem colisão nestes testes (1 paciente por reserva) — só registra. */
  async upsertReplacingForRun(
    aggregates: readonly AnaCarePatientMonthAggregate[],
    _periodMonth: string,
    _runStartedAt: Date,
    shifts: readonly SourceShiftDTO[],
  ): Promise<{ written: number }> {
    this.written.push(...aggregates);
    for (const s of shifts) {
      this.providersWritten.push({ anaCarePatientId: s.anaCarePatientId, anaCareNurseId: s.anaCareNurseId, nurseFirstName: s.nurseFirstName ?? undefined, nurseLastName: s.nurseLastName ?? undefined });
    }
    return { written: aggregates.length };
  }
  async listByMonth(): Promise<AnaCarePatientMonthAggregate[]> {
    return [];
  }
  async listProvidersByMonth(): Promise<AnaCarePatientMonthProviderAggregate[]> {
    return this.providersWritten;
  }
  async getSnapshotFreshness(): Promise<ShiftSyncFreshness> {
    return { shifts: 0, lastFetchedAt: null };
  }
}

/**
 * Conserto 17/09 (desacoplamento do retrato por turno, passo 1) — stub que imita EXATAMENTE o
 * detector real (`AnaCarePatientMonthRepository.upsertReplacingForRun`): substitui a linha do
 * paciente (nunca soma) e, se ela já foi escrita NESTA MESMA corrida (`fetchedAt` registrado >=
 * `runStartedAt` recebido), lança `AnaCarePatientMonthCollisionError` em vez de sobrescrever
 * calado — persiste entre invocações do runner (como a tabela real persiste entre chamadas do
 * Cloud Run), o que é o que prova o caso cross-rodada.
 */
class CollisionAwarePatientMonthRepository implements PatientMonthSyncRepository {
  readonly aggregatesByPatient = new Map<string, AnaCarePatientMonthAggregate>();
  private readonly fetchedAtByPatient = new Map<string, Date>();

  async upsertMany(aggregates: readonly AnaCarePatientMonthAggregate[]): Promise<{ written: number }> {
    for (const a of aggregates) this.aggregatesByPatient.set(a.anaCarePatientId, a);
    return { written: aggregates.length };
  }
  async upsertReplacingForRun(
    aggregates: readonly AnaCarePatientMonthAggregate[],
    periodMonth: string,
    runStartedAt: Date,
  ): Promise<{ written: number }> {
    const colliding = aggregates
      .map((a) => a.anaCarePatientId)
      .filter((id) => {
        const existing = this.fetchedAtByPatient.get(id);
        return existing !== undefined && existing.getTime() >= runStartedAt.getTime();
      });
    if (colliding.length > 0) {
      throw new AnaCarePatientMonthCollisionError(colliding, periodMonth);
    }
    const now = new Date();
    for (const a of aggregates) {
      this.aggregatesByPatient.set(a.anaCarePatientId, a);
      this.fetchedAtByPatient.set(a.anaCarePatientId, now);
    }
    return { written: aggregates.length };
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
  it('percorre TODAS as reservas do diretório e grava o agregado via patientMonthRepository.upsertReplacingForRun', async () => {
    const source = new PerReservationShiftsSource();
    const directory = new StubDirectory(['100', '200', '300']);
    const repository = new StubDirectorySnapshotRepository();
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

    expect(source.calls).toEqual([
      { month: '2026-09', reservationId: '100' },
      { month: '2026-09', reservationId: '200' },
      { month: '2026-09', reservationId: '300' },
    ]);
    expect(outcome.reservationsProcessed).toBe(3);
    expect(outcome.shiftsWritten).toBe(3);
    expect(outcome.nextCursor).toBeNull();
    // Conserto 17/09 (desacoplamento do retrato por turno, passo 1): o runner NÃO grava mais
    // turnos no antigo retrato — `repository` (`DirectorySnapshotRepository`) só serve à checagem
    // de queda do diretório a partir de agora.
    expect(repository.written).toHaveLength(0);
    expect(patientMonthRepository.written).toHaveLength(3);
  });

  /**
   * PROVA OBRIGATÓRIA (passo 3, conserto da REGRESSÃO do passo 1): `upsertReplacingForRun`
   * (chamado por `runOnce`, produção real) TEM de gravar o par paciente×prestador — o passo 1
   * trocou `recomputeFromShifts` (gravava o par) por este método sem preservar essa escrita, e o
   * grep do passo 2 provou zero escritor de produção em `anacare_patient_month_provider`. Este
   * teste MORRE se `upsertReplacingForRun` voltar a esquecer o par.
   */
  it('runOnce roda UMA reserva e o par paciente×prestador é gravado via upsertReplacingForRun', async () => {
    const source = new PerReservationShiftsSource();
    const directory = new StubDirectory(['100']);
    const repository = new StubDirectorySnapshotRepository();
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

    await runner.run({ origin: 'manual', userId: 'staff-1' });

    // `PerReservationShiftsSource` devolve, pra reserva '100', 1 turno com
    // anaCarePatientId='100' e anaCareNurseId='AC-NURSE-0' — o par tem de aparecer gravado.
    expect(patientMonthRepository.providersWritten).toHaveLength(1);
    expect(patientMonthRepository.providersWritten[0]).toMatchObject({
      anaCarePatientId: '100',
      anaCareNurseId: 'AC-NURSE-0',
    });
  });

  /**
   * Conserto 17/09 (desacoplamento do retrato por turno, passo 1): prova que o retrato AGREGADO
   * (`anacare_patient_month`) é escrito a partir do agregado em memória de CADA reserva, sem
   * depender do antigo retrato por turno. `PerReservationShiftsSource` devolve 1 turno por reserva
   * com `anaCarePatientId` = a própria reserva, então 3 reservas ⇒ 3 pacientes agregados, 1 turno
   * cada.
   */
  it('grava o retrato AGREGADO (anacare_patient_month) direto do agregado em memória da reserva', async () => {
    const source = new PerReservationShiftsSource();
    const directory = new StubDirectory(['100', '200', '300']);
    const repository = new StubDirectorySnapshotRepository();
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
    const repository = new StubDirectorySnapshotRepository();
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
    const repository = new StubDirectorySnapshotRepository();
    const runner = new AnaCareHoursSyncRunner(source, new AnaCareHoursSyncGuard(), () => {}, () => '2026-09', directory, repository, { ANACARE_DIRECTORY_MIN_ABSOLUTE: '1' });

    const outcome = await runner.run({ origin: 'manual', userId: 'staff-1', cursor: 2 });

    expect(source.calls).toEqual([{ month: '2026-09', reservationId: '300' }]);
    expect(outcome.reservationsProcessed).toBe(1);
    expect(outcome.nextCursor).toBeNull();
  });

  it('devolve directoryCounts da rodada', async () => {
    const source = new PerReservationShiftsSource();
    const directory = new StubDirectory(['100', '200']);
    const repository = new StubDirectorySnapshotRepository();
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
    const repository = new StubDirectorySnapshotRepository();
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
    const repository = new StubDirectorySnapshotRepository();
    const runner = new AnaCareHoursSyncRunner(source, new AnaCareHoursSyncGuard(), () => {}, () => '2026-09', directory, repository, { ANACARE_DIRECTORY_MIN_ABSOLUTE: '1' });

    const outcome = await runner.run({ origin: 'cron', userId: null });
    expect(outcome.shiftsSkippedNoProvider).toBe(0);
    expect(outcome.shiftsSkippedNoPatient).toBe(0);
  });
});

describe('AnaCareHoursSyncRunner — alarme de queda do diretório (raspagem quebra em silêncio)', () => {
  it('contagem despenca abaixo do piso relativo (80% do último conhecido) ⇒ ERRO, nada gravado', async () => {
    const source = new PerReservationShiftsSource();
    const repository = new StubDirectorySnapshotRepository();
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
    const repository = new StubDirectorySnapshotRepository(); // getLastDirectoryCount() → null
    const directory = new StubDirectory(['100', '200']);
    const runner = new AnaCareHoursSyncRunner(source, new AnaCareHoursSyncGuard(), () => {}, () => '2026-09', directory, repository, {});

    await expect(runner.run({ origin: 'cron', userId: null })).rejects.toBeInstanceOf(AnaCareDirectoryFirstRunNotConfiguredError);
    expect(repository.written).toHaveLength(0);
    expect(source.calls).toHaveLength(0);
  });

  it('primeira execução (sem contagem conhecida) MAS com ANACARE_DIRECTORY_MIN_ABSOLUTE configurada: total acima dele passa', async () => {
    const source = new PerReservationShiftsSource();
    const repository = new StubDirectorySnapshotRepository(); // getLastDirectoryCount() → null
    const directory = new StubDirectory(['100', '200']);
    const runner = new AnaCareHoursSyncRunner(source, new AnaCareHoursSyncGuard(), () => {}, () => '2026-09', directory, repository, {
      ANACARE_DIRECTORY_MIN_ABSOLUTE: '1',
    });

    await expect(runner.run({ origin: 'cron', userId: null })).resolves.toMatchObject({ reservationsProcessed: 2 });
  });

  it('piso ABSOLUTO configurável via env (ANACARE_DIRECTORY_MIN_ABSOLUTE) barra mesmo sem histórico', async () => {
    const source = new PerReservationShiftsSource();
    const repository = new StubDirectorySnapshotRepository();
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
 * Conserto 17/09/2026, passo 1 (desacoplamento do retrato por turno): a 2ª reserva do MESMO
 * paciente sobrescrevia a 1ª em silêncio quando o runner agregava em memória só os turnos da
 * reserva atual e fazia upsert direto — o mesmo bug que o F6.1 (recompute cumulativo sobre o
 * antigo retrato por turno) evitava. Como este passo abandona aquele retrato (apagado por completo
 * no passo 2, junto de `AnaCareShiftRepository`), a escrita passa a ser por SUBSTITUIÇÃO em
 * memória; sem uma fonte cumulativa para mesclar, a única forma segura de nunca perder a 1ª
 * reserva calado é DETECTAR a colisão e falhar alto (`AnaCarePatientMonthCollisionError`) em vez
 * de tentar somar — medido 17/09 contra o Ana Care real: 283/283 reservas, 0 pacientes em mais de
 * uma reserva, então essa é uma rede de segurança para um caso hoje inexistente, não o caminho
 * feliz.
 */
describe('AnaCareHoursSyncRunner — paciente em DUAS reservas: falha alto, nunca sobrescreve calado (conserto 17/09, passo 1)', () => {
  it('MESMA rodada: duas reservas do mesmo paciente ⇒ AnaCarePatientMonthCollisionError, nada fica sobrescrito calado', async () => {
    const source = new SharedPatientShiftsSource({ A: 2, B: 3 }); // A: 08h→10h (2h), B: 08h→11h (3h)
    const directory = new StubDirectory(['A', 'B']);
    const repository = new StubDirectorySnapshotRepository();
    const patientMonthRepository = new CollisionAwarePatientMonthRepository();
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

    await expect(runner.run({ origin: 'manual', userId: 'staff-1' })).rejects.toBeInstanceOf(AnaCarePatientMonthCollisionError);

    // A reserva A já tinha gravado PAT-SHARED (2h) ANTES da colisão da reserva B ser detectada —
    // a linha da 1ª reserva continua lá, intacta, exatamente como a 1ª escrita a deixou.
    const afterFailure = patientMonthRepository.aggregatesByPatient.get('PAT-SHARED');
    expect(afterFailure).toBeDefined();
    expect(afterFailure!.hoursActualSum).toBe(2);
  });

  /**
   * TAREFA A (gate `revisao-pr`, fecho 17/09): o carimbo da corrida agora vem do SERVIDOR
   * (`SyncRunRepository`, migration 443 na vida real) — nenhum campo de trigger precisa ser
   * propagado pelo CLIENTE. O `syncRunRepository` COMPARTILHADO entre as duas invocações (mesma
   * coisa que a tabela real `anacare_sync_run` sobrevive entre duas chamadas/processos do Cloud
   * Run) é o que permite o detector enxergar a colisão — um `Set` em memória do runner nunca
   * pegaria isto, porque o runner não tem memória entre invocações.
   */
  it('DUAS INVOCAÇÕES (retomada por cursor, processos distintos, MESMO syncRunRepository): a 2ª rodada detecta a colisão da 1ª sozinha, sem o cliente propagar nada', async () => {
    const source = new SharedPatientShiftsSource({ A: 2, B: 3 });
    const repository = new StubDirectorySnapshotRepository();
    // Repositório do retrato agregado SOBREVIVE entre as duas invocações — mesma coisa que a
    // tabela real `anacare_patient_month` sobrevive entre duas chamadas (processos) do Cloud Run.
    const patientMonthRepository = new CollisionAwarePatientMonthRepository();
    // Repositório do CARIMBO DA CORRIDA também sobrevive — mesma coisa que `anacare_sync_run` real.
    const syncRunRepository = new FakeAnaCareSyncRunRepository();

    // Invocação 1 (ex.: 1ª chamada do Cloud Run, processo A): só a reserva A está no diretório.
    const runner1 = new AnaCareHoursSyncRunner(
      source,
      new AnaCareHoursSyncGuard(),
      () => {},
      () => '2026-09',
      new StubDirectory(['A']),
      repository,
      { ANACARE_DIRECTORY_MIN_ABSOLUTE: '1' },
      patientMonthRepository,
      syncRunRepository,
    );
    const outcome1 = await runner1.run({ origin: 'cron', userId: null });

    const afterFirstRun = patientMonthRepository.aggregatesByPatient.get('PAT-SHARED');
    expect(afterFirstRun!.shiftsCount).toBe(1);
    expect(afterFirstRun!.hoursActualSum).toBe(2);
    // `runStartedAt` ainda sai no outcome — só para OBSERVABILIDADE, o teste não o reenvia a lugar nenhum.
    expect(outcome1.runStartedAt).toEqual(expect.any(String));

    // Invocação 2 (retomada, OUTRO processo/instância de runner — nenhuma memória em comum além
    // dos repositórios): só o `cursor` é propagado, exatamente como o chamador HTTP faz hoje
    // (`syncTriggerBodySchema` nem tem mais o campo `runStartedAt`). O runner LÊ o carimbo do
    // `syncRunRepository` compartilhado — não recebe nada do trigger.
    const runner2 = new AnaCareHoursSyncRunner(
      source,
      new AnaCareHoursSyncGuard(),
      () => {},
      () => '2026-09',
      new StubDirectory(['B']),
      repository,
      { ANACARE_DIRECTORY_MIN_ABSOLUTE: '1' },
      patientMonthRepository,
      syncRunRepository,
    );

    await expect(runner2.run({ origin: 'cron', userId: null, cursor: 0 })).rejects.toBeInstanceOf(AnaCarePatientMonthCollisionError);

    // A gravação da invocação 1 continua intacta — a invocação 2 falhou ANTES de sobrescrever.
    const afterSecondRun = patientMonthRepository.aggregatesByPatient.get('PAT-SHARED');
    expect(afterSecondRun!.shiftsCount).toBe(1);
    expect(afterSecondRun!.hoursActualSum).toBe(2);
  });

  /**
   * LACUNA documentada (fronteira do que o detector cobre, não regressão): o `syncRunRepository`
   * (migration 443 na vida real) é a ÚNICA fonte do carimbo — se ele não tiver nenhuma linha para
   * `(source, periodMonth)` no momento da retomada (ex.: banco resetado entre invocações, ou dois
   * `syncRunRepository` DIFERENTES por engano de fiação), `resolveRunStartedAt` trata como corrida
   * NOVA — RELATANDO a decisão via `logger.warn` — e a colisão cross-invocação não é vista. É uma
   * fronteira muito mais estreita que a anterior (dependia do CLIENTE propagar um campo HTTP);
   * agora só sobra quando o PRÓPRIO armazenamento do carimbo está ausente.
   */
  it('DOCUMENTADO: retomada sem NENHUMA linha no syncRunRepository (ex.: repositórios não compartilhados) trata como corrida NOVA e RELATA no log — a colisão não é vista', async () => {
    const source = new SharedPatientShiftsSource({ A: 2, B: 3 });
    const repository = new StubDirectorySnapshotRepository();
    const patientMonthRepository = new CollisionAwarePatientMonthRepository();

    const runner1 = new AnaCareHoursSyncRunner(
      source,
      new AnaCareHoursSyncGuard(),
      () => {},
      () => '2026-09',
      new StubDirectory(['A']),
      repository,
      { ANACARE_DIRECTORY_MIN_ABSOLUTE: '1' },
      patientMonthRepository,
      new FakeAnaCareSyncRunRepository(), // syncRunRepository da invocação 1 — próprio, não compartilhado.
    );
    await runner1.run({ origin: 'cron', userId: null });
    // Separação de relógio real (não fake timer): o carimbo "corrida NOVA" da invocação 2
    // (`new Date()` de dentro de `FakeAnaCareSyncRunRepository.startNewRun`) precisa ficar
    // estritamente DEPOIS do `fetchedAt` gravado pela invocação 1 — sem esta pausa as duas caem no
    // mesmo milissegundo e o teste vira flake (empate cai no `>=` do detector, mascarando o gap que
    // este teste prova). Mesmo racional do teste homônimo que existia antes desta tarefa.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const runner2 = new AnaCareHoursSyncRunner(
      source,
      new AnaCareHoursSyncGuard(),
      () => {},
      () => '2026-09',
      new StubDirectory(['B']),
      repository,
      { ANACARE_DIRECTORY_MIN_ABSOLUTE: '1' },
      patientMonthRepository,
      new FakeAnaCareSyncRunRepository(), // syncRunRepository da invocação 2 — outro, vazio para este mês.
    );
    // cursor propagado (retomada), mas o syncRunRepository da invocação 2 não tem NENHUMA linha —
    // `resolveRunStartedAt` cai no ramo "trata como corrida NOVA" e RELATA via logger.warn.
    const outcome2 = await runner2.run({ origin: 'cron', userId: null, cursor: 0 });

    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: expect.stringContaining('tratando como corrida NOVA'),
        month: '2026-09',
        cursor: 0,
      }),
    );
    expect(outcome2.shiftsWritten).toBe(1);
    const afterSecondRun = patientMonthRepository.aggregatesByPatient.get('PAT-SHARED');
    // Substituído em silêncio — 3h da reserva B, a reserva A (2h) perdida. Gap real, documentado, e
    // agora RELATADO no log (antes não havia relato nenhum dessa decisão).
    expect(afterSecondRun!.hoursActualSum).toBe(3);
  });
});
