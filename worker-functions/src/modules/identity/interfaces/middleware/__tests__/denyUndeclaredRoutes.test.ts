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
  GOVERNED_ROUTES,
  isGovernedPath,
  isGovernedRoute,
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
/** Staff fora do prefixo — governada por NOME (`GOVERNED_ROUTES`, 19/08). */
const encuadre: ScannedRoute = { method: 'PUT', path: '/api/workers/:id/status' };

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

/**
 * O perímetro por NOME (19/08). `workerEncuadreRoutes` serve 10 rotas
 * `requireStaff` sob `/api/workers/` e `/api/cases/` — inclusive escrita de
 * funil. Fora do prefixo elas eram `not_governed`: invisíveis ao
 * deny-by-default, à lista de pendências e ao oráculo.
 */
describe('GOVERNED_ROUTES — o perímetro que o prefixo não alcança', () => {
  it('a rota nomeada é governada, mesmo sem casar prefixo nenhum', () => {
    expect(isGovernedPath(encuadre.path)).toBe(false);
    expect(isGovernedRoute(encuadre)).toBe(true);
  });

  it('MÉTODO faz parte da chave — `GET /api/workers/:id/status` não é a mesma rota', () => {
    expect(isGovernedRoute({ method: 'GET', path: '/api/workers/:id/status' })).toBe(false);
  });

  it('as rotas do PRESTADOR seguem fora — é o ponto de não ter ampliado o prefixo', () => {
    for (const path of ['/api/workers/me', '/api/workers/me/documents', '/api/workers/lookup']) {
      expect(isGovernedRoute({ method: 'GET', path })).toBe(false);
    }
  });

  it('a lista tem as 10 rotas de encuadre e nada além', () => {
    expect([...GOVERNED_ROUTES].sort()).toEqual(
      [
        'GET /api/cases/:caseNumber/encuadres',
        'GET /api/cases/:caseNumber/workers',
        'GET /api/workers/:id/cases',
        'GET /api/workers/:id/encuadres',
        'GET /api/workers/by-status/:status',
        'GET /api/workers/docs-expiring',
        'GET /api/workers/status-dashboard',
        'PUT /api/workers/:id/doc-expiry',
        'PUT /api/workers/:id/occupation',
        'PUT /api/workers/:id/status',
      ].sort(),
    );
  });

  it('pelo caminho CONCRETO da request, quem resolve é o índice — não o prefixo', () => {
    // `/api/workers/abc-123/status` não casa prefixo nenhum. Se o pré-filtro de
    // caminho ainda fosse o primeiro corte, a rota voltaria a ser `not_governed`
    // e a lista nomeada não valeria nada em runtime.
    //
    // ⚠️ A asserção é "NÃO é `not_governed`", e o valor exato vem do fixture —
    // que é uma `ScannedRoute` sem célula. A versão anterior deste caso afirmava
    // `'pending'`, e quebrou quando o A6 declarou a família e tirou a rota da
    // dívida: estava acoplada à LISTA em vez de ao MECANISMO, que é o que o caso
    // existe para provar.
    const registry = registryCom([encuadre]);

    const status = registry.statusOf('PUT', '/api/workers/abc-123/status');

    expect(status).not.toBe('not_governed');
    expect(status).toBe('undeclared');
  });

  it('governada por nome, sem célula e fora das listas → `undeclared` (a rede pega)', () => {
    // É este o desfecho que o perímetro existe para produzir: antes da lista
    // nomeada, uma rota de staff criada ali nascia `not_governed` e passava.
    const registry = new UndeclaredRouteRegistry({ exempt: new Set(), pending: new Set() });
    registry.publish([encuadre]);
    expect(registry.statusOf('PUT', '/api/workers/abc-123/status')).toBe('undeclared');
    expect(registry.unexpectedlyUndeclared()).toEqual([encuadre]);
  });

  it('sem índice publicado, caminho fora do prefixo continua `not_governed`', () => {
    // O comportamento de antes do boot não mudou: só o prefixo responde aqui.
    const registry = new UndeclaredRouteRegistry();
    expect(registry.statusOf('PUT', '/api/workers/abc-123/status')).toBe('not_governed');
    expect(registry.statusOf('GET', '/api/admin/qualquer')).toBe('unknown');
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
