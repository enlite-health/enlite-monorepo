/**
 * F4 (task 4.8) — prova no nível HTTP: o botão (`/api/admin/.../sync`) e o Cloud Scheduler
 * (`/api/internal/.../sync`) são DUAS rotas, mas chamam o MESMO `AnaCareHoursSyncController` (a
 * mesma instância, como monta `index.ts`) — então um disparo concorrente entre as duas rotas
 * também dedupa. Sabotagem: montar cada rota com um controller DIFERENTE prova que aí NÃO dedupa
 * (2 rodadas reais) — evidenciando que é a instância compartilhada quem garante 4.8, não a rota.
 */
import express from 'express';
import request from 'supertest';
import { PermissionMiddleware, type AuthMiddleware } from '@modules/identity';
import { createAnaCareHoursSyncAdminRoutes, createAnaCareHoursSyncInternalRoutes } from '../anacareHoursSyncRoutes';
import { AnaCareHoursSyncController } from '../../controllers/AnaCareHoursSyncController';
import { AnaCareHoursSyncRunner } from '../../../application/AnaCareHoursSyncRunner';
import type { AnaCareShiftsSource, ListShiftsParams, SourceShiftDTO } from '../../../domain/AnaCareShiftsSource';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
  reportError: jest.fn(),
}));

function authDouble(): AuthMiddleware {
  const passa = () => (req: express.Request, _res: unknown, next: express.NextFunction) => {
    req.authContext ??= { principal: { id: 'dublê-staff', roles: ['admin'] } } as never;
    next();
  };
  return { requireStaff: passa, requireStaffOrApiKey: passa, requireAuth: passa } as unknown as AuthMiddleware;
}

function permissionsDouble(): PermissionMiddleware {
  return new PermissionMiddleware({
    client: { resolve: jest.fn(), can: jest.fn(), isFeatureAvailable: jest.fn(), featureConfig: jest.fn(), invalidate: jest.fn() },
    audit: { record: jest.fn() },
    env: {},
  });
}

class CountingShiftsSource implements AnaCareShiftsSource {
  calls = 0;
  async listShifts(_params: ListShiftsParams): Promise<SourceShiftDTO[]> {
    this.calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 30));
    return [];
  }
  async getShift(): Promise<SourceShiftDTO | null> {
    return null;
  }
  async getRetratoStatus() {
    return { stale: false, circuitBreakerOpen: false };
  }
}

function buildApp(controller: AnaCareHoursSyncController): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', createAnaCareHoursSyncAdminRoutes(controller, authDouble(), permissionsDouble()));
  app.use('/api/internal', createAnaCareHoursSyncInternalRoutes(controller));
  return app;
}

describe('rotas de sync — botão (admin) e Cloud Scheduler (internal) compartilham o guard (4.8)', () => {
  it('MESMA instância de controller: disparo manual + cron concorrentes dedupam (1 request à fonte)', async () => {
    const source = new CountingShiftsSource();
    const runner = new AnaCareHoursSyncRunner(source);
    const controller = new AnaCareHoursSyncController(() => runner);
    const app = buildApp(controller);

    const [manual, cron] = await Promise.all([
      request(app).post('/api/admin/anacare-hours/sync').send({}),
      request(app).post('/api/internal/anacare-hours/sync').send({}),
    ]);

    expect(manual.status).toBe(200);
    expect(cron.status).toBe(200);
    expect(source.calls).toBe(1);
  });

  it('SABOTAGEM: controllers DIFERENTES (sem instância compartilhada) NÃO dedupam entre as rotas', async () => {
    const source = new CountingShiftsSource();
    const runnerA = new AnaCareHoursSyncRunner(source);
    const runnerB = new AnaCareHoursSyncRunner(source);
    const appSabotado = express();
    appSabotado.use(express.json());
    appSabotado.use('/api/admin', createAnaCareHoursSyncAdminRoutes(new AnaCareHoursSyncController(() => runnerA), authDouble(), permissionsDouble()));
    appSabotado.use('/api/internal', createAnaCareHoursSyncInternalRoutes(new AnaCareHoursSyncController(() => runnerB)));

    await Promise.all([
      request(appSabotado).post('/api/admin/anacare-hours/sync').send({}),
      request(appSabotado).post('/api/internal/anacare-hours/sync').send({}),
    ]);

    expect(source.calls).toBe(2); // prova que o dedup depende da instância COMPARTILHADA, não da rota isolada
  });
});
