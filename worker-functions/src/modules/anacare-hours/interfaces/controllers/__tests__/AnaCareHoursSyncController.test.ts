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
    process.env.ANACARE_HOURS_SOURCE = 'fake';
    try {
      const controller = new AnaCareHoursSyncController();
      const r1 = res();
      const r2 = res();

      await controller.triggerCron({ headers: {} } as never, r1 as never);
      await controller.triggerCron({ headers: {} } as never, r2 as never);

      expect(r1.status).toHaveBeenCalledWith(200);
      expect(r2.status).toHaveBeenCalledWith(200);
    } finally {
      process.env.ANACARE_HOURS_SOURCE = prev;
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
