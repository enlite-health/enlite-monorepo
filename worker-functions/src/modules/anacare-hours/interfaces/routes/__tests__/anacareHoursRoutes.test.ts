/**
 * Rotas da conferência de horas do Ana Care no `main` (sem ABAC — allowlist de e-mail no lugar
 * das células da stage, ver `requireAnaCareHoursAllowlist`). Confirma: as 5 rotas existem, todas
 * exigem staff + allowlist (403 fora dela), e cada handler é chamado corretamente quando passa.
 */
const mockPoolQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({ query: mockPoolQuery }) }),
  },
}));

import express from 'express';
import request from 'supertest';
import type { AuthMiddleware } from '@modules/identity';
import { createAnaCareHoursRoutes } from '../anacareHoursRoutes';
import type { AnaCareHoursController } from '../../controllers/AnaCareHoursController';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
}));

const ALLOWED_EMAIL = 'marcel@enlite.health';

function authDouble(): AuthMiddleware {
  const passa = () => (req: express.Request, _res: unknown, next: express.NextFunction) => {
    (req as any).user = { uid: 'uid-fixo', roles: ['admin'] };
    (req as any).authContext = { principal: { id: 'uid-fixo', roles: ['admin'] } };
    next();
  };
  return { requireStaff: passa, requireStaffOrApiKey: passa, requireAuth: passa } as unknown as AuthMiddleware;
}

function controllerDuble(): AnaCareHoursController {
  const responde = (nome: string) => (req: express.Request, res: express.Response) =>
    res.json({ m: nome, params: req.params });
  return {
    getMonthSnapshot: responde('getMonthSnapshot'),
    getPatientMonth: responde('getPatientMonth'),
    validateShift: responde('validateShift'),
    validateBatch: responde('validateBatch'),
    contestShift: responde('contestShift'),
  } as unknown as AnaCareHoursController;
}

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/admin', createAnaCareHoursRoutes(controllerDuble(), authDouble()));
  return a;
}

describe('createAnaCareHoursRoutes (main, allowlist)', () => {
  const ORIGINAL_ENV = process.env.ANACARE_HOURS_ALLOWED_EMAILS;

  beforeEach(() => {
    process.env.ANACARE_HOURS_ALLOWED_EMAILS = ALLOWED_EMAIL;
  });

  afterEach(() => {
    jest.clearAllMocks();
    process.env.ANACARE_HOURS_ALLOWED_EMAILS = ORIGINAL_ENV;
  });

  it.each([
    ['get', '/api/admin/anacare-hours/months/2026-09', 'getMonthSnapshot'],
    ['get', '/api/admin/anacare-hours/months/2026-09/patients/AC-PAT-0', 'getPatientMonth'],
    ['post', '/api/admin/anacare-hours/shifts/validate-batch', 'validateBatch'],
    ['post', '/api/admin/anacare-hours/shifts/s1/validate', 'validateShift'],
    ['post', '/api/admin/anacare-hours/shifts/s1/contest', 'contestShift'],
  ])('%s %s — e-mail NA allowlist chama o handler %s (200)', async (method, path, esperado) => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ email: ALLOWED_EMAIL }] });
    const res = await (request(app()) as never as Record<string, (p: string) => request.Test>)[method](path);
    expect(res.status).toBe(200);
    expect(res.body.m).toBe(esperado);
  });

  it.each([
    ['get', '/api/admin/anacare-hours/months/2026-09'],
    ['get', '/api/admin/anacare-hours/months/2026-09/patients/AC-PAT-0'],
    ['post', '/api/admin/anacare-hours/shifts/validate-batch'],
    ['post', '/api/admin/anacare-hours/shifts/s1/validate'],
    ['post', '/api/admin/anacare-hours/shifts/s1/contest'],
  ])('%s %s — staff FORA da allowlist recebe 403, handler NUNCA é chamado', async (method, path) => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ email: 'nao.autorizado@enlite.health' }] });
    const res = await (request(app()) as never as Record<string, (p: string) => request.Test>)[method](path);
    expect(res.status).toBe(403);
    expect(res.body.m).toBeUndefined();
  });
});
