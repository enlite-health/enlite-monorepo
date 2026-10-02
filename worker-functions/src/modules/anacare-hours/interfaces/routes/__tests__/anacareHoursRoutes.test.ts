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

/** A trilha em si é assunto do e2e; o dublê EXECUTA a função de `action`/`idFrom` que a rota passou. */
const trilhas: Array<{ tipo: string; acao: string; id: string | undefined }> = [];
jest.mock('@shared/audit/resourceAccessLog', () => ({
  logResourceAccess:
    (tipo: string, acao: string | ((req: unknown) => string), idFrom?: (req: unknown) => string | undefined) =>
    (req: unknown, _res: unknown, next: () => void) => {
      trilhas.push({ tipo, acao: typeof acao === 'function' ? acao(req) : acao, id: idFrom?.(req) });
      next();
    },
}));

const READ = 'anacare_hours:read';
const EXPORT = 'anacare_hours:export';
const VALIDATE = 'anacare_hours:validate';

const ESPERADO: Record<string, string> = {
  'GET /anacare-hours/months/:month': READ,
  'GET /anacare-hours/months/:month/patients/:patientId': READ,
  'POST /anacare-hours/shifts/validate-batch': VALIDATE,
  'POST /anacare-hours/shifts/:shiftId/validate': VALIDATE,
  'POST /anacare-hours/shifts/:shiftId/contest': VALIDATE,
  // spec 032: 1ª célula declarada = read; a 2ª (export) está em `cells` — ver o teste dedicado.
  'GET /anacare-hours/patients/:patientId/export': READ,
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
    exportPatientRange: responde('exportPatientRange'),
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

  it('cada uma das 6 rotas declara a célula esperada', () => {
    const declarado = Object.fromEntries(
      scanExpressRouter(build()).map((route: ScannedRoute) => [
        `${route.method} ${route.path}`,
        route.cell ? cellKey(route.cell.resource, route.cell.action) : null,
      ]),
    );
    expect(declarado).toEqual(ESPERADO);
  });

  it('são exatamente 6 rotas', () => {
    expect(scanExpressRouter(build())).toHaveLength(6);
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
    ['get', '/api/admin/anacare-hours/patients/AC-PAT-0/export?desde=2026-09-01&hasta=2026-09-30', 'exportPatientRange'],
  ])('%s %s chama o handler %s', async (method, path, esperado) => {
    const res = await (request(app()) as never as Record<string, (p: string) => request.Test>)[method](path);
    expect(res.status).toBe(200);
    expect(res.body.m).toBe(esperado);
  });

  describe('GET /anacare-hours/patients/:patientId/export (spec 032)', () => {
    const URL = '/api/admin/anacare-hours/patients/AC-PAT-0/export?desde=2026-09-01&hasta=2026-09-30';

    beforeEach(() => {
      trilhas.length = 0;
    });

    it('declara as DUAS células, read e export, nessa ordem (chamadas literais, sem closure)', () => {
      const rota = scanExpressRouter(build()).find((r: ScannedRoute) => r.path === '/anacare-hours/patients/:patientId/export');
      expect((rota?.cells ?? []).map((c) => cellKey(c.resource, c.action))).toEqual([READ, EXPORT]);
    });

    it('a trilha registra anacare_patient com o id da fonte e a ação enumerada (desde/hasta), sem nome', async () => {
      const res = await request(app()).get(URL);
      expect(res.status).toBe(200);
      expect(trilhas).toEqual([{ tipo: 'anacare_patient', acao: 'export_xlsx:ambos:2026-09-01:2026-09-30', id: 'AC-PAT-0' }]);
    });

    it('ordem dos middlewares: staffOnly → read → export → trilha → handler', async () => {
      const ordem: string[] = [];
      const auth = {
        requireStaff: () => (_q: express.Request, _s: unknown, next: express.NextFunction) => {
          ordem.push('staffOnly');
          next();
        },
      } as unknown as AuthMiddleware;
      const perms = {
        family: () => ({
          require: (recurso: string, acao: string) => (_q: express.Request, _s: unknown, next: express.NextFunction) => {
            ordem.push(`${recurso}:${acao}`);
            next();
          },
        }),
      } as unknown as PermissionMiddleware;
      const controller = { exportPatientRange: (_q: express.Request, s: express.Response) => { ordem.push('handler'); s.json({}); } } as unknown as AnaCareHoursController;
      const a = express();
      a.use('/api/admin', createAnaCareHoursRoutes(controller, auth, perms));
      const trilhaAntes = trilhas.length;
      await request(a).get(URL);
      expect(ordem).toEqual(['staffOnly', READ, EXPORT, 'handler']);
      expect(trilhas.length).toBe(trilhaAntes + 1); // a trilha está na cadeia (dublê registra ao passar)
    });

    it('sem a célula :export → 403 e o handler NÃO roda (read sozinho não basta)', async () => {
      let handlerRodou = false;
      const perms = {
        family: () => ({
          require: (recurso: string, acao: string) => (_q: express.Request, s: express.Response, next: express.NextFunction) =>
            `${recurso}:${acao}` === EXPORT ? s.status(403).json({ success: false }) : next(),
        }),
      } as unknown as PermissionMiddleware;
      const controller = { exportPatientRange: (_q: express.Request, s: express.Response) => { handlerRodou = true; s.json({}); } } as unknown as AnaCareHoursController;
      const a = express();
      a.use('/api/admin', createAnaCareHoursRoutes(controller, authDouble(), perms));
      const res = await request(a).get(URL);
      expect(res.status).toBe(403);
      expect(handlerRodou).toBe(false);
      expect(trilhas).toEqual([]);
    });

    it('não colide com as rotas de mês: /months/... continua indo ao handler do mês', async () => {
      const res = await request(app()).get('/api/admin/anacare-hours/months/2026-09/patients/AC-PAT-0');
      expect(res.body.m).toBe('getPatientMonth');
    });
  });
});
