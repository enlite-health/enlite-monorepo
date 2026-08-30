/**
 * adminWorkerRoutes.test.ts
 *
 * Cada rota registrada chama o método certo do controller certo, sob o
 * middleware certo (staff × admin × staff-ou-api-key). E a ordem: as rotas
 * estáticas (/map, /filter-options, /export…) vêm ANTES de /workers/:id —
 * senão o Express captura "map" como id.
 */
import express from 'express';
import request from 'supertest';
import { createAdminWorkerRoutes, type AdminWorkerRouteControllers } from '../adminWorkerRoutes';
import type { AuthMiddleware } from '@modules/identity';

type Handler = (req: express.Request, res: express.Response) => void;
const respond = (name: string): jest.Mock<void, [express.Request, express.Response]> =>
  jest.fn((_req: express.Request, res: express.Response) => { res.status(200).json({ handler: name }); });

function makeControllers(withMap = true): AdminWorkerRouteControllers & { calls: Record<string, jest.Mock> } {
  const calls: Record<string, jest.Mock> = {};
  const c = (name: string): Handler => (calls[name] = respond(name));
  const controllers = {
    workers: { listWorkers: c('listWorkers'), getWorkerById: c('getWorkerById'), getWorkerByPhone: c('getWorkerByPhone'), exportWorkers: c('exportWorkers') },
    aux: { getWorkerDateStats: c('getWorkerDateStats'), listCaseOptions: c('listCaseOptions'), getFilterOptions: c('getFilterOptions'), syncTalentumWorkers: c('syncTalentumWorkers') },
    testFlag: { updateTestFlag: c('updateTestFlag') },
    profile: { updateProfile: c('updateProfile') },
    serviceArea: { updateServiceArea: c('updateServiceArea') },
    tags: { list: c('tagsList'), create: c('tagsCreate'), update: c('tagsUpdate'), delete: c('tagsDelete'), assign: c('tagsAssign'), remove: c('tagsRemove') },
    timeline: { getTimeline: c('getTimeline') },
    ...(withMap ? { map: { getMapPoints: c('getMapPoints') } } : {}),
  } as unknown as AdminWorkerRouteControllers;
  return Object.assign(controllers, { calls });
}

const seen: string[] = [];
const guard = (label: string) => (req: express.Request, _res: express.Response, next: express.NextFunction) => { seen.push(`${label} ${req.method} ${req.path}`); next(); };
const authMiddleware = {
  requireStaff: () => guard('staff'),
  requireStaffOrApiKey: () => guard('staffOrApiKey'),
  requireAdmin: () => guard('admin'),
} as unknown as AuthMiddleware;

function app(controllers: AdminWorkerRouteControllers): express.Express {
  const a = express();
  a.use(express.json());
  a.use('/api/admin', createAdminWorkerRoutes(controllers, authMiddleware));
  return a;
}

const ID = '11111111-1111-1111-1111-111111111111';

describe('createAdminWorkerRoutes', () => {
  beforeEach(() => { seen.length = 0; });

  const cases: Array<[string, string, string, string]> = [
    // método, path, handler, guarda
    ['get', '/workers/stats', 'getWorkerDateStats', 'staff'],
    ['get', '/workers/by-phone', 'getWorkerByPhone', 'staffOrApiKey'],
    ['get', '/workers/case-options', 'listCaseOptions', 'staff'],
    ['get', '/workers/filter-options', 'getFilterOptions', 'staff'],
    ['post', '/workers/map', 'getMapPoints', 'staff'],
    ['post', '/workers/sync-talentum', 'syncTalentumWorkers', 'staff'],
    ['get', '/workers/export', 'exportWorkers', 'admin'],
    ['get', `/workers/${ID}/timeline`, 'getTimeline', 'staff'],
    ['get', `/workers/${ID}`, 'getWorkerById', 'staff'],
    ['patch', `/workers/${ID}/test-flag`, 'updateTestFlag', 'admin'],
    ['patch', `/workers/${ID}/profile`, 'updateProfile', 'admin'],
    ['put', `/workers/${ID}/service-area`, 'updateServiceArea', 'admin'],
    ['get', '/workers', 'listWorkers', 'staff'],
    ['get', '/worker-tags', 'tagsList', 'staff'],
    ['post', '/worker-tags', 'tagsCreate', 'admin'],
    ['patch', `/worker-tags/${ID}`, 'tagsUpdate', 'admin'],
    ['delete', `/worker-tags/${ID}`, 'tagsDelete', 'admin'],
    ['post', `/workers/${ID}/tags/${ID}`, 'tagsAssign', 'staff'],
    ['delete', `/workers/${ID}/tags/${ID}`, 'tagsRemove', 'staff'],
  ];

  it.each(cases)('%s %s → %s (guarda %s)', async (method, path, handler, guardLabel) => {
    const controllers = makeControllers();
    const res = await (request(app(controllers)) as unknown as Record<string, (p: string) => request.Test>)[method](`/api/admin${path}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ handler });
    expect(controllers.calls[handler]).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([`${guardLabel} ${method.toUpperCase()} ${path}`]);
  });

  it('GET /workers/map não existe (é POST) e "map" não é capturado como :id', async () => {
    const controllers = makeControllers();
    const res = await request(app(controllers)).get('/api/admin/workers/map');
    // Cai em /workers/:id — e é o controller de detalhe que recebe "map", não o do mapa.
    expect(res.body).toEqual({ handler: 'getWorkerById' });
    expect(controllers.calls.getMapPoints).not.toHaveBeenCalled();
  });

  it('sem controller de mapa, POST /workers/map é 404 e o resto continua', async () => {
    const controllers = makeControllers(false);
    const a = app(controllers);
    expect((await request(a).post('/api/admin/workers/map')).status).toBe(404);
    expect((await request(a).get('/api/admin/workers')).body).toEqual({ handler: 'listWorkers' });
  });
});
