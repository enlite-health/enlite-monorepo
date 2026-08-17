/**
 * Deny-by-default de ROTA (task 3.4). O que se prova aqui é a diferença entre
 * os quatro desfechos — declarada, isenta, pendente de rollout e NOVA sem
 * declaração —, porque é essa diferença que impede o guard de virar ou um
 * carimbo inútil (tudo pendente) ou um blecaute (tudo negado).
 */

import express from 'express';
import request from 'supertest';
import {
  denyUndeclaredRoutes,
  isGovernedPath,
  UndeclaredRouteRegistry,
} from '../denyUndeclaredRoutes';
import type { ScannedRoute } from '@modules/identity/permissions';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
}));

const declarada: ScannedRoute = {
  method: 'GET',
  path: '/api/admin/users',
  cell: { resource: 'user_management', action: 'read' },
};
const isenta: ScannedRoute = { method: 'GET', path: '/api/admin/auth/profile' };
const nova: ScannedRoute = { method: 'POST', path: '/api/admin/coisa-nova' };
const foraDoDominio: ScannedRoute = { method: 'GET', path: '/api/workers/me' };

function registryCom(routes: ScannedRoute[]): UndeclaredRouteRegistry {
  const registry = new UndeclaredRouteRegistry();
  registry.publish(routes);
  return registry;
}

describe('isGovernedPath', () => {
  // A raiz do prefixo conta como governada (`/analytics` É rota montada). Isso
  // não nega nada sozinho: sem rota registrada casando, o status é `unknown`.
  it.each([
    ['/api/admin/users', true],
    ['/api/admin', true],
    ['/analytics/dashboard', true],
    ['/analytics', true],
    ['/api/admins-outra-coisa', false],
    ['/api/workers/me', false],
    ['/health', false],
  ])('%s → %s', (path, esperado) => {
    expect(isGovernedPath(path)).toBe(esperado);
  });
});

describe('UndeclaredRouteRegistry', () => {
  it('antes do boot publicar, tudo é desconhecido (e o guard deixa passar)', () => {
    const registry = new UndeclaredRouteRegistry();
    expect(registry.statusOf('GET', '/api/admin/users')).toBe('unknown');
    expect(registry.all()).toEqual([]);
    expect(registry.unexpectedlyUndeclared()).toEqual([]);
  });

  it('classifica declarada, isenta, fora do domínio e nova', () => {
    const registry = registryCom([declarada, isenta, nova, foraDoDominio]);
    expect(registry.statusOf('GET', '/api/admin/users')).toBe('declared');
    expect(registry.statusOf('GET', '/api/admin/auth/profile')).toBe('exempt');
    expect(registry.statusOf('POST', '/api/admin/coisa-nova')).toBe('undeclared');
    expect(registry.statusOf('GET', '/api/workers/me')).toBe('not_governed');
  });

  it('caminho governado que não casa com rota nenhuma é desconhecido, não negado', () => {
    const registry = registryCom([declarada]);
    expect(registry.statusOf('GET', '/api/admin/nao-existe')).toBe('unknown');
  });

  it('rota na lista de PENDENTES é dívida conhecida, não dívida nova', () => {
    const registry = new UndeclaredRouteRegistry({ pending: new Set(['POST /api/admin/coisa-nova']) });
    registry.publish([nova]);
    expect(registry.statusOf('POST', '/api/admin/coisa-nova')).toBe('pending');
    expect(registry.unexpectedlyUndeclared()).toEqual([]);
  });

  it('declaresCell diz o que o novo modelo governa — e nada antes do boot publicar', () => {
    const vazio = new UndeclaredRouteRegistry();
    expect(vazio.declaresCell('user_management', 'read')).toBe(false);

    const registry = registryCom([declarada, nova]);
    expect(registry.declaresCell('user_management', 'read')).toBe(true);
    expect(registry.declaresCell('user_management', 'delete')).toBe(false);
    expect(registry.declaresCell('user', 'admin_delete')).toBe(false);
  });

  it('caixa diferente no caminho NÃO escapa do guard (o Express despacha igual)', () => {
    const registry = registryCom([nova]);
    expect(registry.statusOf('POST', '/API/ADMIN/coisa-nova')).toBe('undeclared');
    expect(isGovernedPath('/API/Admin/qualquer')).toBe(true);
  });

  it('unexpectedlyUndeclared lista só a dívida NOVA', () => {
    const registry = registryCom([declarada, isenta, nova, foraDoDominio]);
    expect(registry.unexpectedlyUndeclared()).toEqual([nova]);
  });
});

describe('denyUndeclaredRoutes', () => {
  function appCom(registry: UndeclaredRouteRegistry, env: NodeJS.ProcessEnv) {
    const app = express();
    app.use(denyUndeclaredRoutes(registry, { env }));
    app.get('/api/admin/users', (_req, res) => res.json({ ok: true }));
    app.post('/api/admin/coisa-nova', (_req, res) => res.json({ ok: true }));
    app.get('/api/admin/auth/profile', (_req, res) => res.json({ ok: true }));
    app.get('/api/workers/me', (_req, res) => res.json({ ok: true }));
    return app;
  }

  const registry = registryCom([declarada, isenta, nova, foraDoDominio]);

  it('com o engine DESLIGADO não opina (ambiente neutro até a virada)', async () => {
    const app = appCom(registry, {});
    await request(app).post('/api/admin/coisa-nova').expect(200);
  });

  it('com o engine ligado, rota nova sem declaração → 403', async () => {
    const app = appCom(registry, { PERMISSION_ENGINE_ENABLED: 'true' });
    const res = await request(app).post('/api/admin/coisa-nova').expect(403);
    expect(res.body.code).toBe('undeclared_route');
  });

  it('declarada, isenta e fora do domínio passam com o engine ligado', async () => {
    const app = appCom(registry, { PERMISSION_ENGINE_ENABLED: 'true' });
    await request(app).get('/api/admin/users').expect(200);
    await request(app).get('/api/admin/auth/profile').expect(200);
    await request(app).get('/api/workers/me').expect(200);
  });

  it('REPORT_ONLY loga e deixa passar', async () => {
    const app = appCom(registry, { PERMISSION_ENGINE_ENABLED: 'true', PERMISSION_REPORT_ONLY: 'true' });
    await request(app).post('/api/admin/coisa-nova').expect(200);
  });
});
