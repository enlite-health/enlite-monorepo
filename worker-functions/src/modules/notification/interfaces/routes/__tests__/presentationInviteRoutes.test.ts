/**
 * presentationInviteRoutes.test.ts — cada rota do REQ-09 chama o método certo do controller sob a
 * guarda certa: leitura e clique são de staff; a configuração (PUT) é só de admin, auditada.
 */
import express from 'express';
import { permissionsDouble } from '@modules/identity/interfaces/middleware/__tests__/permissionFamilyDoubles';
import request from 'supertest';
import { createPresentationInviteRoutes } from '../presentationInviteRoutes';
import type { PresentationInviteController } from '../../controllers/PresentationInviteController';
import type { AuthMiddleware } from '@modules/identity';

const respond = (name: string): jest.Mock<void, [express.Request, express.Response]> =>
  jest.fn((_req: express.Request, res: express.Response) => { res.status(200).json({ handler: name }); });

function makeController(): PresentationInviteController & { calls: Record<string, jest.Mock> } {
  const calls: Record<string, jest.Mock> = {};
  const c = (name: string) => (calls[name] = respond(name));
  const controller = { getSettings: c('getSettings'), updateSettings: c('updateSettings'), last: c('last'), stats: c('stats'), invite: c('invite') } as unknown as PresentationInviteController;
  return Object.assign(controller, { calls });
}

const seen: string[] = [];
const guard = (label: string) => (req: express.Request, _res: express.Response, next: express.NextFunction) => { seen.push(`${label} ${req.method} ${req.path}`); next(); };
const authMiddleware = { requireStaff: () => guard('staff'), requireAdmin: () => guard('admin') } as unknown as AuthMiddleware;

function app(controller: PresentationInviteController): express.Express {
  const a = express();
  a.use(express.json());
  a.use('/api/admin', createPresentationInviteRoutes(controller, authMiddleware, permissionsDouble()));
  return a;
}

const ID = '11111111-1111-1111-1111-111111111111';

describe('createPresentationInviteRoutes', () => {
  beforeEach(() => { seen.length = 0; });

  const cases: Array<[string, string, string, string]> = [
    // método, path, handler, guarda
    ['get', '/presentation-invite/settings', 'getSettings', 'staff'],
    ['put', '/presentation-invite/settings', 'updateSettings', 'admin'],
    ['get', '/presentation-invite/last', 'last', 'staff'],
    ['get', '/presentation-invite/stats', 'stats', 'staff'],
    ['post', `/workers/${ID}/presentation-invite`, 'invite', 'staff'],
  ];

  it.each(cases)('%s %s → %s (guarda %s)', async (method, path, handler, guardLabel) => {
    const controller = makeController();
    const res = await (request(app(controller)) as unknown as Record<string, (p: string) => request.Test>)[method](`/api/admin${path}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ handler });
    expect(controller.calls[handler]).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([`${guardLabel} ${method.toUpperCase()} ${path}`]);
  });

  it('a configuração NÃO aceita POST/PATCH (só PUT admin) e a rota do clique NÃO aceita GET', async () => {
    const controller = makeController();
    const a = app(controller);
    expect((await request(a).post('/api/admin/presentation-invite/settings')).status).toBe(404);
    expect((await request(a).patch('/api/admin/presentation-invite/settings')).status).toBe(404);
    expect((await request(a).get(`/api/admin/workers/${ID}/presentation-invite`)).status).toBe(404);
    expect(controller.calls.updateSettings).not.toHaveBeenCalled();
    expect(controller.calls.invite).not.toHaveBeenCalled();
  });
});
