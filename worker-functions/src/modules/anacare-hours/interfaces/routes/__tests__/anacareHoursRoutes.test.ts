/**
 * Rotas da conferência de horas do Ana Care — mesmo molde de
 * `adminTherapeuticProjectsRoutes.test.ts`: varre o router de VERDADE com `scanExpressRouter`
 * (o mesmo que alimenta o catálogo de células) e confere o mapa rota→célula à mão.
 */
import express from 'express';
import request from 'supertest';
import { PermissionMiddleware, type AuthMiddleware } from '@modules/identity';
import { scanExpressRouter, cellKey, undeclaredRoutes, type ScannedRoute } from '@modules/identity/permissions';
import { createAnaCareHoursRoutes } from '../anacareHoursRoutes';
import type { AnaCareHoursController } from '../../controllers/AnaCareHoursController';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
}));

/**
 * Dublês locais (mesmo contrato de `permissionFamilyDoubles.ts`, que este módulo não pode importar
 * — não está na lista de módulos com boundary registrado, e importar o caminho não-barrel de
 * `identity` violaria a regra de import do ESLint). `authDouble` deixa passar como admin;
 * `permissionsDouble` é o `PermissionMiddleware` REAL com client/trilha falsos e `env: {}` — sem
 * `PERMISSION_ENGINE_ENABLED`, todo guard cai no `next()`, e o que este teste mede é a DECLARAÇÃO
 * da célula (`scanExpressRouter`), não a decisão do engine.
 */
function authDouble(): AuthMiddleware {
  const passa = () => (req: express.Request, _res: unknown, next: express.NextFunction) => {
    req.authContext ??= { principal: { id: 'dublê-admin', roles: ['admin'] } } as never;
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

const READ = 'anacare_hours:read';
const VALIDATE = 'anacare_hours:validate';

const ESPERADO: Record<string, string> = {
  'GET /anacare-hours/months/:month': READ,
  'GET /anacare-hours/months/:month/patients/:patientId': READ,
  'POST /anacare-hours/shifts/validate-batch': VALIDATE,
  'POST /anacare-hours/shifts/:shiftId/validate': VALIDATE,
  'POST /anacare-hours/shifts/:shiftId/contest': VALIDATE,
};

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

const build = () => createAnaCareHoursRoutes(controllerDuble(), authDouble(), permissionsDouble());

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/admin', build());
  return a;
}

describe('createAnaCareHoursRoutes', () => {
  it('TODA rota do router declara célula — nenhuma passa sem declaração', () => {
    expect(undeclaredRoutes(scanExpressRouter(build()), () => true)).toEqual([]);
  });

  it('cada uma das 5 rotas declara a célula esperada', () => {
    const declarado = Object.fromEntries(
      scanExpressRouter(build()).map((route: ScannedRoute) => [
        `${route.method} ${route.path}`,
        route.cell ? cellKey(route.cell.resource, route.cell.action) : null,
      ]),
    );
    expect(declarado).toEqual(ESPERADO);
  });

  it('são exatamente 5 rotas', () => {
    expect(scanExpressRouter(build())).toHaveLength(5);
  });

  it('nenhuma rota é DELETE/PUT/PATCH — só GET e POST', () => {
    const metodos = new Set(scanExpressRouter(build()).map((r: ScannedRoute) => r.method));
    expect([...metodos].sort()).toEqual(['GET', 'POST']);
  });

  it.each([
    ['get', '/api/admin/anacare-hours/months/2026-09', 'getMonthSnapshot'],
    ['get', '/api/admin/anacare-hours/months/2026-09/patients/AC-PAT-0', 'getPatientMonth'],
    ['post', '/api/admin/anacare-hours/shifts/validate-batch', 'validateBatch'],
    ['post', '/api/admin/anacare-hours/shifts/s1/validate', 'validateShift'],
    ['post', '/api/admin/anacare-hours/shifts/s1/contest', 'contestShift'],
  ])('%s %s chama o handler %s', async (method, path, esperado) => {
    const res = await (request(app()) as never as Record<string, (p: string) => request.Test>)[method](path);
    expect(res.status).toBe(200);
    expect(res.body.m).toBe(esperado);
  });
});
