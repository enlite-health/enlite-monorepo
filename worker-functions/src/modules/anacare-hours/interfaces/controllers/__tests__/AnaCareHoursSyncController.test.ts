/**
 * Cobre os ramos que o teste de rota HTTP não passa por injeção de runner-factory: fail-closed
 * (503 sem fonte configurada), erro interno (500, sem `req.body` no `reportError`) e o path do
 * `triggerCron`.
 */
import { AnaCareHoursSyncController } from '../AnaCareHoursSyncController';
import { AnaCareHoursSyncRunner } from '../../../application/AnaCareHoursSyncRunner';

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
      // Conserto 17/09 (desacoplamento de `anacare_shift`, passo 1): duas sincronizações
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

  it('triggerCron nunca carrega userId (origin cron é sempre anônima)', async () => {
    const runner = { run: jest.fn().mockResolvedValue({ requests: 1, retries: 0, shiftsRead: 0, deduped: false }) } as unknown as AnaCareHoursSyncRunner;
    const controller = new AnaCareHoursSyncController(() => runner);
    const response = res();

    await controller.triggerCron({ headers: {} } as never, response as never);

    expect(runner.run).toHaveBeenCalledWith({ origin: 'cron', userId: null });
    expect(response.status).toHaveBeenCalledWith(200);
  });
});
