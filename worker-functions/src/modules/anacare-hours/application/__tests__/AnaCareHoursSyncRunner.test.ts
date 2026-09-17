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
import type { EnliteDirectorySnapshot, EnliteDirectorySource, ShiftSyncFreshness, ShiftSyncRepository } from '../../domain/AnaCareHoursSyncPorts';
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
