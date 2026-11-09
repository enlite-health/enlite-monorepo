/**
 * Classe de rota (acesso-do-cliente F3, T303): o scanner lê a marca de classe
 * em Express de VERDADE, em router aninhado e em `app.use(path, mw)`.
 */

import express, { Router, type RequestHandler } from 'express';
import {
  scanExpressRouter,
  type ScannedRoute,
  markRouteClass,
  type RouteClass,
  readRouteClass,
  routeClass,
  ROUTE_CLASSES,
  exemptHandler,
} from '@modules/identity/permissions';
import { UndeclaredRouteRegistry, isGovernedRoute } from '../interfaces/middleware/denyUndeclaredRoutes';
import { AuthMiddleware } from '../interfaces/middleware/AuthMiddleware';

const ok: RequestHandler = (_req, res) => res.json({});

function classOf(routes: ReturnType<typeof scanExpressRouter>, method: string, path: string) {
  return routes.find((r) => r.method === method && r.path === path)?.class;
}

describe('routeClass — marca de classe lida pelo scanner', () => {
  it('lê os 4 valores (staff, public, service, client-policy)', () => {
    const app = express();
    const staff = markRouteClass(((_q, _s, n) => n()) as RequestHandler, 'staff');
    app.get('/staff', staff, ok);
    app.get('/public', routeClass('public'), ok);
    app.get('/service', routeClass('service'), ok);
    app.get('/client', routeClass('client-policy'), ok);

    const routes = scanExpressRouter(app);
    expect(classOf(routes, 'GET', '/staff')).toBe('staff');
    expect(classOf(routes, 'GET', '/public')).toBe('public');
    expect(classOf(routes, 'GET', '/service')).toBe('service');
    expect(classOf(routes, 'GET', '/client')).toBe('client-policy');
    expect([...ROUTE_CLASSES].sort()).toEqual(['client-policy', 'public', 'service', 'staff']);
  });

  it('rota sem marca lê null', () => {
    const app = express();
    app.get('/sem', ok);
    app.get('/so-isenta', exemptHandler('self'), ok);
    const routes = scanExpressRouter(app);
    expect(classOf(routes, 'GET', '/sem')).toBeNull();
    expect(classOf(routes, 'GET', '/so-isenta')).toBeNull();
  });

  it('marca em router aninhado é lida, só na rota marcada', () => {
    const app = express();
    const inner = Router();
    inner.post('/marcada', routeClass('client-policy'), ok);
    inner.post('/outra', ok);
    const outer = Router();
    outer.use('/x', inner);
    app.use('/api', outer);

    const routes = scanExpressRouter(app);
    expect(classOf(routes, 'POST', '/api/x/marcada')).toBe('client-policy');
    expect(classOf(routes, 'POST', '/api/x/outra')).toBeNull();
  });

  it('app.use(path, mw) com classe é lida (limitação (a) da T301)', () => {
    const app = express();
    app.use('/api/aberto', routeClass('public'));
    const routes = scanExpressRouter(app);
    const used = routes.find((r) => r.method === 'USE' && r.path === '/api/aberto');
    expect(used?.class).toBe('public');
    expect(used?.cells).toEqual([]);
  });

  it('requireStaff() marca staff', () => {
    const middleware = new AuthMiddleware({} as never, {} as never);
    const guard = middleware.requireStaff();
    expect(readRouteClass(guard)).toBe('staff');

    const app = express();
    app.get('/admin-like', guard, ok);
    expect(classOf(scanExpressRouter(app), 'GET', '/admin-like')).toBe('staff');
  });

  it('requireStaffOrApiKey() marca staff (a marca não muda o guard)', () => {
    const middleware = new AuthMiddleware({} as never, {} as never);
    const guard = middleware.requireStaffOrApiKey();
    expect(readRouteClass(guard)).toBe('staff');
    const app = express();
    app.get('/staff-ou-chave', guard, ok);
    expect(classOf(scanExpressRouter(app), 'GET', '/staff-ou-chave')).toBe('staff');
  });

  it('classe de middleware no MOUNT é herdada pelas filhas; a classe própria da filha vence', () => {
    const middleware = new AuthMiddleware({} as never, {} as never);
    const child = express.Router();
    child.get('/sem-classe', ok);
    child.get('/propria', routeClass('service'), ok);
    const deep = express.Router();
    deep.post('/fundo', ok);
    child.use('/sub', deep);
    const app = express();
    app.use('/api/admin/messaging', middleware.requireStaff(), child);
    app.use('/api/outro', express.Router().get('/x', ok)); // sem classe no mount: continua sem classe
    const routes = scanExpressRouter(app);
    expect(classOf(routes, 'GET', '/api/admin/messaging/sem-classe')).toBe('staff');
    expect(classOf(routes, 'GET', '/api/admin/messaging/propria')).toBe('service');
    expect(classOf(routes, 'POST', '/api/admin/messaging/sub/fundo')).toBe('staff');
    expect(classOf(routes, 'GET', '/api/outro/x')).toBeNull();
  });

  it('readRouteClass ignora o que não é função', () => {
    expect(readRouteClass(undefined)).toBeUndefined();
    expect(readRouteClass({})).toBeUndefined();
  });

  it('rota com classe não-staff conta como declarada para o denyUndeclaredRoutes; staff sem célula não', () => {
    const registry = new UndeclaredRouteRegistry();
    const rota = (cls: RouteClass | null, path: string): ScannedRoute => ({ method: 'GET', path, cells: [], class: cls });
    for (const cls of ['service', 'client-policy', 'public'] as const) {
      expect(isGovernedRoute(rota(cls, '/v1/fora-do-prefixo'))).toBe(true);
      expect(registry.statusOfRoute(rota(cls, '/api/admin/x'))).toBe('exempt');
    }
    expect(registry.statusOfRoute(rota('staff', '/api/admin/x'))).toBe('undeclared');
    expect(registry.statusOfRoute(rota(null, '/api/admin/x'))).toBe('undeclared');
  });
});
