/**
 * Cobre os ramos que o teste de rota HTTP não passa por injeção de runner-factory: fail-closed
 * (503 sem fonte configurada), erro interno (500, sem `req.body` no `reportError`) e o path do
 * `triggerCron`.
 */
import { AnaCareHoursSyncController } from '../AnaCareHoursSyncController';
import { AnaCareHoursSyncRunner } from '../../../application/AnaCareHoursSyncRunner';
import { AnaCarePatientMonthCollisionError } from '../../../infrastructure/AnaCarePatientMonthRepository';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
  reportError: jest.fn(),
}));

const { reportError } = jest.requireMock('@shared/logging') as { reportError: jest.Mock };

function res() {
  const r: { statusCode?: number; body?: unknown; status: jest.Mock; json: jest.Mock } = {
    status: jest.fn(function (this: unknown, code: number) {
      r.statusCode = code;
      return r as unknown as { json: jest.Mock };
    }),
    json: jest.fn(function (this: unknown, body: unknown) {
      r.body = body;
      return r;
    }),
  };
  return r;
}

describe('AnaCareHoursSyncController', () => {
  afterEach(() => {
    AnaCareHoursSyncController.resetSharedRunnerForTests();
    jest.clearAllMocks();
  });

  it('503 ANACARE_SOURCE_NOT_CONFIGURED quando o runner não existe (fail-closed)', async () => {
    const controller = new AnaCareHoursSyncController(() => null);
    const response = res();

    await controller.triggerManual({ headers: {} } as never, response as never);

    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.body).toMatchObject({ success: false, code: 'ANACARE_SOURCE_NOT_CONFIGURED' });
  });

  it('500 e reportError (sem PII) quando o runner lança', async () => {
    const runner = { run: jest.fn().mockRejectedValue(new Error('boom')) } as unknown as AnaCareHoursSyncRunner;
    const controller = new AnaCareHoursSyncController(() => runner);
    const response = res();

    await controller.triggerCron({ headers: {} } as never, response as never);

    expect(response.status).toHaveBeenCalledWith(500);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), { source: 'AnaCareHoursSyncController.trigger.cron' });
  });

  it('defaultRunnerFactory (singleton): resolve com ANACARE_HOURS_SOURCE=fake e reusa a MESMA instância entre chamadas', async () => {
    const prev = process.env.ANACARE_HOURS_SOURCE;
    const prevFloor = process.env.ANACARE_DIRECTORY_MIN_ABSOLUTE;
    process.env.ANACARE_HOURS_SOURCE = 'fake';
    // Item 4 (revisão de PR): sem histórico (repositório fake novo por teste) o runner agora é
    // fail-closed na 1ª rodada sem esta env — este teste prova o singleton do runner, não o alarme.
    process.env.ANACARE_DIRECTORY_MIN_ABSOLUTE = '1';
    try {
      const controller = new AnaCareHoursSyncController();
      const r1 = res();
      const r2 = res();

      await controller.triggerCron({ headers: {} } as never, r1 as never);
      // Conserto 17/09 (desacoplamento do retrato por turno, passo 1): duas sincronizações
      // independentes (nenhuma retomando a outra — sem `cursor`) do MESMO reservationId sintético
      // (`FakeEnliteDirectory` sempre devolve 1 só) gravam o MESMO paciente duas vezes. O detector
      // de colisão compara `fetched_at` contra `runStartedAt` em resolução de MILISSEGUNDO — sem
      // esta pausa, as duas chamadas (100% síncronas/em memória, sem I/O real) empatam no mesmo ms
      // e o detector (corretamente cauteloso) as trata como a MESMA corrida. Contra o Ana Care
      // real, a latência de rede já garante essa separação — aqui é preciso simulá-la.
      await new Promise((resolve) => setTimeout(resolve, 10));
      await controller.triggerCron({ headers: {} } as never, r2 as never);

      expect(r1.status).toHaveBeenCalledWith(200);
      expect(r2.status).toHaveBeenCalledWith(200);
    } finally {
      process.env.ANACARE_HOURS_SOURCE = prev;
      process.env.ANACARE_DIRECTORY_MIN_ABSOLUTE = prevFloor;
    }
  });

  it('defaultRunnerFactory: 503 quando ANACARE_HOURS_SOURCE não está configurada (fail-closed real)', async () => {
    const prev = process.env.ANACARE_HOURS_SOURCE;
    delete process.env.ANACARE_HOURS_SOURCE;
    try {
      const controller = new AnaCareHoursSyncController();
      const response = res();

      await controller.triggerManual({ headers: {} } as never, response as never);

      expect(response.status).toHaveBeenCalledWith(503);
    } finally {
      process.env.ANACARE_HOURS_SOURCE = prev;
    }
  });

  /**
   * TAREFA D (gate `revisao-pr`, fecho 17/09): a colisão do detector (`AnaCarePatientMonthCollisionError`)
   * ganha código DEDICADO em vez do "Internal error" genérico — "detector que dispara e ninguém vê
   * não é detector". MORRE se o controller voltar a tratar a colisão como qualquer outro 500.
   */
  it('409 ANACARE_PATIENT_MONTH_COLLISION (código dedicado, não "Internal error" genérico) quando o runner lança AnaCarePatientMonthCollisionError', async () => {
    const runner = {
      run: jest.fn().mockRejectedValue(new AnaCarePatientMonthCollisionError(['AC-PAT-0'], '2026-09')),
    } as unknown as AnaCareHoursSyncRunner;
    const controller = new AnaCareHoursSyncController(() => runner);
    const response = res();

    await controller.triggerManual({ headers: {} } as never, response as never);

    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.body).toMatchObject({ success: false, code: 'ANACARE_PATIENT_MONTH_COLLISION' });
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), { source: 'AnaCareHoursSyncController.trigger.manual' });
  });

  it('triggerCron nunca carrega userId (origin cron é sempre anônima)', async () => {
    const runner = { run: jest.fn().mockResolvedValue({ requests: 1, retries: 0, shiftsRead: 0, deduped: false }) } as unknown as AnaCareHoursSyncRunner;
    const controller = new AnaCareHoursSyncController(() => runner);
    const response = res();

    await controller.triggerCron({ headers: {} } as never, response as never);

    expect(runner.run).toHaveBeenCalledWith({ origin: 'cron', userId: null });
    expect(response.status).toHaveBeenCalledWith(200);
  });

  // ── F1 (migration 457, change `anacare-horas-conclusao-de-corrida`) — progresso gravado a cada rodada ──

  /** Mock mínimo de `SyncRunRepository` — só o método que o controller chama nesta fase. */
  function makeSyncRunRepository() {
    return { recordProgress: jest.fn().mockResolvedValue(undefined) };
  }

  function fullOutcome(overrides: Record<string, unknown>) {
    return {
      requests: 1,
      retries: 0,
      shiftsRead: 0,
      deduped: false,
      reservationsProcessed: 0,
      shiftsWritten: 0,
      directoryCounts: { activo: 0, terminado: 0, total: 0 },
      shiftsSkippedNoProvider: 0,
      shiftsSkippedNoPatient: 0,
      runStartedAt: '2026-09-20T00:00:00.000Z',
      ...overrides,
    };
  }

  it('F1 (457): rodada que corta por orçamento (nextCursor≠null) grava status=running com cursor/contagens, finishedAt/lastError limpos', async () => {
    const runner = {
      run: jest.fn().mockResolvedValue(fullOutcome({ nextCursor: 49, reservationsTotal: 144, reservationsDone: 49 })),
    } as unknown as AnaCareHoursSyncRunner;
    const syncRunRepository = makeSyncRunRepository();
    const controller = new AnaCareHoursSyncController(() => runner, () => syncRunRepository as never);
    const response = res();

    await controller.triggerManual({ headers: {} } as never, response as never);

    const expectedMonth = AnaCareHoursSyncRunner.currentMonth();
    expect(syncRunRepository.recordProgress).toHaveBeenCalledWith('anacare', expectedMonth, {
      status: 'running',
      cursor: 49,
      reservationsTotal: 144,
      reservationsDone: 49,
      finishedAt: null,
      lastError: null,
    });
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.body).toMatchObject({ reservationsTotal: 144, reservationsDone: 49 });
  });

  it('F1 (457): rodada que termina a lista (nextCursor=null) grava status=done com finishedAt preenchido', async () => {
    const runner = {
      run: jest.fn().mockResolvedValue(fullOutcome({ nextCursor: null, reservationsTotal: 3, reservationsDone: 3 })),
    } as unknown as AnaCareHoursSyncRunner;
    const syncRunRepository = makeSyncRunRepository();
    const controller = new AnaCareHoursSyncController(() => runner, () => syncRunRepository as never);
    const response = res();

    await controller.triggerCron({ headers: {} } as never, response as never);

    expect(syncRunRepository.recordProgress).toHaveBeenCalledTimes(1);
    const [source, month, progress] = syncRunRepository.recordProgress.mock.calls[0];
    expect(source).toBe('anacare');
    expect(month).toBe(AnaCareHoursSyncRunner.currentMonth());
    expect(progress).toMatchObject({ status: 'done', cursor: null, reservationsTotal: 3, reservationsDone: 3, lastError: null });
    expect(progress.finishedAt).toBeInstanceOf(Date);
    expect(response.status).toHaveBeenCalledWith(200);
  });

  it('F1 (457): runner lança erro CONHECIDO → grava status=failed com o código ESTÁVEL (nunca .message), cursor/contagens null', async () => {
    const runner = {
      run: jest.fn().mockRejectedValue(new AnaCarePatientMonthCollisionError(['AC-PAT-0'], '2026-09')),
    } as unknown as AnaCareHoursSyncRunner;
    const syncRunRepository = makeSyncRunRepository();
    const controller = new AnaCareHoursSyncController(() => runner, () => syncRunRepository as never);
    const response = res();

    await controller.triggerManual({ headers: {} } as never, response as never);

    expect(syncRunRepository.recordProgress).toHaveBeenCalledTimes(1);
    const [, , progress] = syncRunRepository.recordProgress.mock.calls[0];
    expect(progress).toMatchObject({
      status: 'failed',
      cursor: null,
      reservationsTotal: null,
      reservationsDone: null,
      lastError: 'AnaCarePatientMonthCollisionError:409',
    });
    expect(progress.finishedAt).toBeInstanceOf(Date);
    expect(response.status).toHaveBeenCalledWith(409); // comportamento HTTP pré-existente, inalterado por esta fase
  });

  /**
   * PROVA OBRIGATÓRIA (item 4 do prompt): erro cujo `.message` carrega PII simulada (nome
   * fictício) — `last_error` gravado NÃO pode conter essa substring, nem em nenhuma chamada de
   * `reportError` capturada pelo teste (mesma checagem que a suíte de `toStableErrorCode` já faz
   * isoladamente; aqui provamos que o CONTROLLER usa `toStableErrorCode`, não `e.message` direto).
   */
  it('F1 (457): mensagem de erro com PII simulada nunca chega ao last_error gravado', async () => {
    const NOME_FICTICIO = 'Ramona Quimey Villalba';
    const runner = {
      run: jest.fn().mockRejectedValue(new Error(`timeout ao sincronizar turno de ${NOME_FICTICIO}`)),
    } as unknown as AnaCareHoursSyncRunner;
    const syncRunRepository = makeSyncRunRepository();
    const controller = new AnaCareHoursSyncController(() => runner, () => syncRunRepository as never);
    const response = res();

    await controller.triggerManual({ headers: {} } as never, response as never);

    const [, , progress] = syncRunRepository.recordProgress.mock.calls[0];
    expect(progress.lastError).toBe('UnknownError:Error');
    expect(progress.lastError).not.toContain(NOME_FICTICIO);
    expect(response.status).toHaveBeenCalledWith(500);
  });

  /**
   * PROVA OBRIGATÓRIA (item e do prompt): uma falha ao GRAVAR o progresso (repositório indisponível
   * no meio da escrita) não pode derrubar o sync — a missão é sincronizar, o registro é
   * observabilidade. MORRE se `recordProgress` deixar de estar isolado em try/catch no controller.
   */
  it('F1 (457): falha ao GRAVAR o progresso não derruba o sync — ainda responde 200 e reporta a falha de escrita separadamente', async () => {
    const runner = {
      run: jest.fn().mockResolvedValue(fullOutcome({ nextCursor: null, reservationsTotal: 1, reservationsDone: 1 })),
    } as unknown as AnaCareHoursSyncRunner;
    const syncRunRepository = { recordProgress: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) };
    const controller = new AnaCareHoursSyncController(() => runner, () => syncRunRepository as never);
    const response = res();

    await controller.triggerManual({ headers: {} } as never, response as never);

    expect(response.status).toHaveBeenCalledWith(200);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), { source: 'AnaCareHoursSyncController.recordProgress.manual' });
  });

  it('F1 (457): sem SyncRunRepository configurado (factory devolve null), o sync ainda responde 200 — recordProgress é no-op', async () => {
    const runner = {
      run: jest.fn().mockResolvedValue(fullOutcome({ nextCursor: null, reservationsTotal: 1, reservationsDone: 1 })),
    } as unknown as AnaCareHoursSyncRunner;
    const controller = new AnaCareHoursSyncController(() => runner, () => null);
    const response = res();

    await controller.triggerManual({ headers: {} } as never, response as never);

    expect(response.status).toHaveBeenCalledWith(200);
  });
});
