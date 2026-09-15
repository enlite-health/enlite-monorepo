/**
 * O inventário vivo de rotas. É o que o e2e lê para afirmar que NENHUMA rota
 * administrativa ficou sem declaração no app real — o oráculo que um teste
 * unitário não alcança (o `src/index.ts` não é importável).
 */

import express from 'express';
import request from 'supertest';
import { UndeclaredRouteRegistry } from '../../middleware/denyUndeclaredRoutes';
import { createPermissionRoutesInventoryRouter } from '../permissionRoutesInventoryRoute';
import type { ScannedRoute } from '@modules/identity/permissions';

const ROTAS: ScannedRoute[] = [
  {
    method: 'GET',
    path: '/api/admin/users',
    cell: { resource: 'user_management', action: 'read' },
    cells: [{ resource: 'user_management', action: 'read' }],
  },
  // Guards ENCADEADOS de recursos diferentes (o molde do achado pós-#391,
  // `activate-recruitment`): a 2ª célula tem de sobreviver no `cells`.
  {
    method: 'POST',
    path: '/api/admin/dupla-celula',
    cell: { resource: 'patient_services', action: 'update' },
    cells: [
      { resource: 'patient_services', action: 'update' },
      { resource: 'vacancy', action: 'update' },
    ],
  },
  { method: 'GET', path: '/api/admin/auth/profile' },
  { method: 'POST', path: '/api/admin/coisa-nova' },
  { method: 'GET', path: '/api/workers/me' },
];

function appCom(guard: express.RequestHandler) {
  const registry = new UndeclaredRouteRegistry();
  registry.publish(ROTAS);
  const app = express();
  app.use('/.well-known', createPermissionRoutesInventoryRouter(registry, guard));
  return app;
}

const passa: express.RequestHandler = (_req, _res, next) => next();
const barra: express.RequestHandler = (_req, res) => {
  res.status(403).end();
};

describe('GET /.well-known/permissions/routes', () => {
  it('exige o guard interno (lex C14: a lista conta topologia)', async () => {
    await request(appCom(barra)).get('/.well-known/permissions/routes').expect(403);
  });

  it('lista só as rotas governadas, com célula e status', async () => {
    const res = await request(appCom(passa)).get('/.well-known/permissions/routes').expect(200);

    expect(res.body.totalRoutes).toBe(5);
    expect(res.body.governedRoutes).toEqual([
      { method: 'GET', path: '/api/admin/users', cell: 'user_management:read', cells: ['user_management:read'], status: 'declared' },
      // A 2ª célula (`vacancy:update`) tem de aparecer em `cells` mesmo `cell`
      // continuando a mostrar só a 1ª (`patient_services:update`) — é o campo
      // que o inventário HTTP não tinha até o achado pós-#391.
      {
        method: 'POST',
        path: '/api/admin/dupla-celula',
        cell: 'patient_services:update',
        cells: ['patient_services:update', 'vacancy:update'],
        status: 'declared',
      },
      { method: 'GET', path: '/api/admin/auth/profile', cell: null, cells: [], status: 'exempt' },
      { method: 'POST', path: '/api/admin/coisa-nova', cell: null, cells: [], status: 'undeclared' },
    ]);
  });

  it('destaca a dívida NOVA em `undeclared` — o que faz o e2e falhar', async () => {
    const res = await request(appCom(passa)).get('/.well-known/permissions/routes').expect(200);
    expect(res.body.undeclared).toEqual(['POST /api/admin/coisa-nova']);
  });

  it('não expõe dado de pessoa — só método, caminho e célula', async () => {
    const res = await request(appCom(passa)).get('/.well-known/permissions/routes').expect(200);
    expect(Object.keys(res.body.governedRoutes[0]).sort()).toEqual(['cell', 'cells', 'method', 'path', 'status']);
  });
});
