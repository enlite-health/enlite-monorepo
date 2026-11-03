/**
 * GET /api/admin/costs/overview (spec 082, CA-4). Os guards são dublês, mas a ORDEM do array da rota é a real:
 * identidade de pessoa (requireStaff, 401) -> célula `platform_costs:read` (403) -> handler. A consulta real ao BigQuery
 * nunca roda aqui: o use case é um dublê.
 */
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  reportError: jest.fn(),
  loggingAls: { getStore: () => undefined },
}));

import { logger } from '@shared/logging';
import { createAdminCostsRoutes } from '../adminCostsRoutes';
import { InvalidMonthError } from '../../../application/GetCostOverviewUseCase';
import { BillingReadError, SyncRateLimitedError, type CostOverview } from '../../../domain/types';

const OVERVIEW: CostOverview = {
  month: '2026-10', currency: 'BRL', dataUntil: '2026-10-11T06:00:00.000Z', monthTotal: 110, prevMonthToDate: 33, prevMonthTotal: 90,
  forecast: { value: 310, basis: 'linear', daysCounted: 10 }, months: [{ month: '2026-10', total: 110 }],
  byService: [{ service: 'Cloud Run', total: 12 }], byResource: [], bySector: [{ sector: '__none__', total: 12 }], byAiCaller: [],
  anomalies: { status: 'insufficient_history', items: [] },
};

let cells: string[];
const execute = jest.fn();

function build() {
  const auth = {
    requireStaff: () => (req: Request, res: Response, next: NextFunction) => {
      const h = req.headers.authorization;
      if (!h || !h.startsWith('Bearer ')) return void res.status(401).json({ error: 'Unauthenticated' });
      next();
    },
  };
  const perms = {
    family: () => ({
      require: (resource: string, action: string) => (_req: Request, res: Response, next: NextFunction) =>
        cells.includes(`${resource}:${action}`) ? next() : void res.status(403).json({ error: 'missing_cell' }),
    }),
  };
  const app = express();
  app.use('/api/admin', createAdminCostsRoutes({ execute }, auth as never, perms as never));
  return app;
}

const URL = '/api/admin/costs/overview';
const PERSON = { Authorization: 'Bearer tok' };

describe('GET /api/admin/costs/overview', () => {
  beforeEach(() => { cells = ['platform_costs:read']; execute.mockReset(); execute.mockResolvedValue(OVERVIEW); });

  it('com a célula platform_costs:read -> 200 com o contrato do overview', async () => {
    const res = await request(build()).get(`${URL}?month=2026-10`).set(PERSON);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: OVERVIEW });
    expect(execute).toHaveBeenCalledWith('2026-10');
  });

  it('sem a célula -> 403 e a consulta não roda', async () => {
    cells = ['pedidos_ia:read'];
    const res = await request(build()).get(URL).set(PERSON);
    expect(res.status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
  });

  it('só identidade de serviço (sem pessoa) -> 401 e a consulta não roda', async () => {
    const res = await request(build()).get(URL).set({ 'X-Enlite-Service': 'Bearer tok-service' });
    expect(res.status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });

  it('mês inválido -> 400', async () => {
    execute.mockRejectedValue(new InvalidMonthError());
    const res = await request(build()).get(`${URL}?month=2026-13`).set(PERSON);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, code: 'invalid_month' });
  });

  it('limite de sincronização -> 429 com retryAfterSeconds (corpo e cabeçalho)', async () => {
    execute.mockRejectedValue(new SyncRateLimitedError(7));
    const res = await request(build()).get(URL).set(PERSON);
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ success: false, code: 'sync_rate_limited', retryAfterSeconds: 7 });
    expect(res.headers['retry-after']).toBe('7');
  });

  it.each(['bytes_limit', 'billing_query_failed'] as const)('erro do leitor %s -> 502 só com o código', async (code) => {
    execute.mockRejectedValue(new BillingReadError(code));
    const res = await request(build()).get(URL).set(PERSON);
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ success: false, code });
  });

  it('erro inesperado -> 502 billing_query_failed, sem repassar o texto do erro', async () => {
    execute.mockRejectedValue(new Error('SECRET-DETAIL'));
    const res = await request(build()).get(URL).set(PERSON);
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain('SECRET-DETAIL');
  });

  it('loga code/reason/name da causa e NUNCA o message', async () => {
    (logger.warn as jest.Mock).mockClear();
    execute.mockRejectedValue(new BillingReadError('billing_query_failed', 'accessDenied', 'ApiError'));
    await request(build()).get(URL).set(PERSON);
    expect(logger.warn).toHaveBeenCalledWith({ code: 'billing_query_failed', reason: 'accessDenied', name: 'ApiError' }, 'costs overview failed');
    execute.mockRejectedValue(new Error('SECRET-DETAIL'));
    await request(build()).get(URL).set(PERSON);
    const logged = JSON.stringify((logger.warn as jest.Mock).mock.calls);
    expect(logged).not.toContain('SECRET-DETAIL');
    expect(logger.warn).toHaveBeenLastCalledWith({ code: 'billing_query_failed', reason: undefined, name: 'Error' }, 'costs overview failed');
  });
});
