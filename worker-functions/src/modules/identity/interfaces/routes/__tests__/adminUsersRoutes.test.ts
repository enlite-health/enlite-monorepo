/**
 * A primeira família a declarar célula. Este arquivo é o teste "rota
 * administrativa sem declaração falha o build" APLICADO à família — varre o
 * router de verdade (o mesmo `scanExpressRouter` do catálogo) e afirma que
 * TODA rota dele declara, e declara a célula certa do mapa.
 *
 * ⚠️ Ele cobre só esta família: `src/index.ts` monta a app com efeito colateral
 * (pools, `listen`) e não pode ser importado aqui. O oráculo COMPLETO das 161
 * rotas é o e2e `permission-route-inventory`, contra o app de pé.
 */

import express from 'express';
import request from 'supertest';
import { scanExpressRouter, cellKey, undeclaredRoutes } from '@modules/identity/permissions';
import { createAdminUsersRoutes, ADMIN_USERS_FAMILY } from '../adminUsersRoutes';
import { PermissionMiddleware } from '../../middleware/PermissionMiddleware';
import type { AdminController } from '../../controllers/AdminController';
import type { AuthMiddleware } from '../../middleware/AuthMiddleware';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
}));

/** Mapa esperado — copiado do route-permission-map.md, não do código. */
const ESPERADO: Record<string, string> = {
  'POST /users': 'user_management:write',
  'GET /users': 'user_management:read',
  'DELETE /users/by-email': 'user_management:delete',
  'DELETE /users/:id': 'user_management:delete',
  'POST /users/:id/reset-password': 'user_management:write',
  'PATCH /users/:id/role': 'permission_management:write',
};

/** Cada handler devolve o próprio nome — é o que identifica quem foi chamado. */
function build(over: { permissions?: PermissionMiddleware } = {}) {
  const responde = (nome: string) => (req: express.Request, res: express.Response) =>
    res.json({ m: nome, id: req.params.id });
  const controller = {
    createAdminUser: responde('createAdminUser'),
    listAdminUsers: responde('listAdminUsers'),
    deleteAdminUser: responde('deleteAdminUser'),
    deleteUserByEmail: responde('deleteUserByEmail'),
    resetAdminPassword: responde('resetAdminPassword'),
    updateAdminRole: responde('updateAdminRole'),
  } as unknown as AdminController;

  const auth = {
    requireAdmin: () => (_req: unknown, _res: unknown, next: express.NextFunction) => next(),
    requireStaff: () => (_req: unknown, _res: unknown, next: express.NextFunction) => next(),
  } as unknown as AuthMiddleware;

  const permissions =
    over.permissions ??
    new PermissionMiddleware({
      client: {
        resolve: jest.fn(),
        can: jest.fn(),
        isFeatureAvailable: jest.fn(),
        featureConfig: jest.fn(),
        invalidate: jest.fn(),
      },
      audit: { record: jest.fn() },
      env: {},
    });

  return createAdminUsersRoutes(controller, auth, permissions);
}

describe('createAdminUsersRoutes', () => {
  it('TODA rota da família declara célula', () => {
    const rotas = scanExpressRouter(build());
    expect(undeclaredRoutes(rotas, () => true)).toEqual([]);
  });

  it('cada rota declara a célula do mapa (route-permission-map.md)', () => {
    const declarado = Object.fromEntries(
      scanExpressRouter(build()).map((route) => [
        `${route.method} ${route.path}`,
        route.cell ? cellKey(route.cell.resource, route.cell.action) : null,
      ]),
    );
    expect(declarado).toEqual(ESPERADO);
  });

  it('mexer em papel exige permission_management:write, não user_management:write', () => {
    const rota = scanExpressRouter(build()).find((r) => r.path === '/users/:id/role');
    expect(rota?.cell).toEqual({
      resource: 'permission_management',
      action: 'write',
      description: null,
    });
  });

  it('`by-email` é registrada ANTES de `:id` — senão o DELETE por e-mail é engolido', async () => {
    const app = express();
    app.use('/api/admin', build());

    const res = await request(app).delete('/api/admin/users/by-email').expect(200);

    expect(res.body.m).toBe('deleteUserByEmail');
  });

  it('DELETE por id continua chegando no handler de id', async () => {
    const app = express();
    app.use('/api/admin', build());

    const res = await request(app).delete('/api/admin/users/abc-123').expect(200);

    expect(res.body).toMatchObject({ m: 'deleteAdminUser', id: 'abc-123' });
  });

  it('a família é `admin.users` — o nome que PERMISSION_ENFORCED_ROUTES liga', () => {
    expect(ADMIN_USERS_FAMILY).toBe('admin.users');
  });

  // Cada rota chega no MÉTODO certo do controller. Trocar dois handlers de
  // lugar numa extração é o erro clássico, e tsc não pega (todas as assinaturas
  // são iguais).
  it.each([
    ['post', '/api/admin/users', 'createAdminUser'],
    ['get', '/api/admin/users', 'listAdminUsers'],
    ['post', '/api/admin/users/1/reset-password', 'resetAdminPassword'],
    ['patch', '/api/admin/users/1/role', 'updateAdminRole'],
  ] as const)('%s %s → %s', async (metodo, caminho, esperado) => {
    const app = express();
    app.use('/api/admin', build());

    const res = await request(app)[metodo](caminho).expect(200);

    expect(res.body.m).toBe(esperado);
  });
});
