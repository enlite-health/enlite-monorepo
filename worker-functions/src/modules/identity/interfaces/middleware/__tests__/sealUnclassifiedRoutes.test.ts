/**
 * Selo F3 (DF-14): rota sem classe, sem célula e sem isenção → 403, em TODA a app
 * (não só `/api/admin`). Com classe, célula ou isenção → passa. O `public` NUNCA é barrado.
 */
import express from 'express';
import request from 'supertest';
import { scanExpressRouter, routeClass } from '@modules/identity/permissions';
import { UndeclaredRouteRegistry } from '../denyUndeclaredRoutes';
import { isUnclassified, sealUnclassifiedRoutes, unclassifiedRoutes } from '../sealUnclassifiedRoutes';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
}));

const ok: express.RequestHandler = (_req, res) => {
  res.json({ ok: true });
};

/** App REAL: o selo montado ANTES das rotas, o índice publicado pela varredura DEPOIS (como o boot). */
function appCom(env: NodeJS.ProcessEnv = {}, publicar = true) {
  const registry = new UndeclaredRouteRegistry();
  const app = express();
  app.use(sealUnclassifiedRoutes(registry, { env }));
  app.get('/sem-classe', ok);
  app.post('/api/workers/sem-classe', ok);
  app.get('/publica', routeClass('public'), ok);
  app.get('/servico', routeClass('service'), ok);
  app.get('/cliente/:id', routeClass('client-policy'), ok);
  if (publicar) registry.publish(scanExpressRouter(app));
  return app;
}

describe('sealUnclassifiedRoutes', () => {
  it('rota sem classe → 403 unclassified_route, em qualquer prefixo', async () => {
    const app = appCom();
    const a = await request(app).get('/sem-classe').expect(403);
    expect(a.body.code).toBe('unclassified_route');
    await request(app).post('/api/workers/sem-classe').expect(403);
    await request(app).head('/sem-classe').expect(403);
  });

  it('rota com classe (public, service, client-policy) → passa', async () => {
    const app = appCom();
    await request(app).get('/publica').expect(200);
    await request(app).get('/servico').expect(200);
    await request(app).get('/cliente/abc').expect(200);
  });

  it('caminho que não existe → 404 do Express (o selo não inventa decisão)', async () => {
    await request(appCom()).get('/nao-existe').expect(404);
  });

  it('antes do boot publicar o índice → passa (corrida de inicialização não derruba)', async () => {
    await request(appCom({}, false)).get('/sem-classe').expect(200);
  });

  it('PERMISSION_REPORT_ONLY=true → loga e deixa passar', async () => {
    await request(appCom({ PERMISSION_REPORT_ONLY: 'true' })).get('/sem-classe').expect(200);
  });

  it('isUnclassified: célula, isenção e classe contam como declaração; USE não é rota', () => {
    expect(isUnclassified({ method: 'GET', path: '/x' })).toBe(true);
    expect(isUnclassified({ method: 'GET', path: '/x', class: null })).toBe(true);
    expect(isUnclassified({ method: 'GET', path: '/x', class: 'staff' })).toBe(false);
    expect(isUnclassified({ method: 'GET', path: '/x', cell: { resource: 'a', action: 'b' } })).toBe(false);
    expect(isUnclassified({ method: 'GET', path: '/x', exempt: { reason: 'r' } as never })).toBe(false);
    expect(isUnclassified({ method: 'USE', path: '/x' })).toBe(false);
  });

  it('unclassifiedRoutes lista só as sem declaração', () => {
    const rotas = scanExpressRouter(appCom());
    expect(rotas).toHaveLength(5);
    expect(unclassifiedRoutes(rotas).map((r) => `${r.method} ${r.path}`)).toEqual(['GET /sem-classe', 'POST /api/workers/sem-classe']);
  });
});
