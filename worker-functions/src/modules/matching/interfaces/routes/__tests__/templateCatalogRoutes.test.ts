/**
 * A rota do catálogo de plantillas (spec 010, F1).
 *
 * F1 é ESPELHO: só leitura. Não existe rota de escrita aqui, e o teste trava
 * isso — a escrita é F2 e está bloqueada por parecer do `lex`. Uma rota de
 * escrita que aparecesse sem passar por lá seria exatamente o que a regra do
 * projeto proíbe.
 *
 * Molde: funnelStageMessagesRoutes.test.ts.
 */
import express from 'express';
import { permissionsDouble } from '@modules/identity/interfaces/middleware/__tests__/permissionFamilyDoubles';
import request from 'supertest';
import { createTemplateCatalogRoutes } from '../templateCatalogRoutes';
import type { TemplateCatalogController } from '../../controllers/TemplateCatalogController';
import type { AuthMiddleware } from '@modules/identity';

const respond = (name: string): jest.Mock =>
  jest.fn((_req: express.Request, res: express.Response) => { res.status(200).json({ handler: name }); });

const seen: string[] = [];
const guard = (label: string) => (req: express.Request, _res: express.Response, next: express.NextFunction) => { seen.push(`${label} ${req.method} ${req.path}`); next(); };
const authMiddleware = {
  requireStaff: () => guard('staff'),
  requireAdmin: () => guard('admin'),
} as unknown as AuthMiddleware;

function makeApp(): { app: express.Express; calls: Record<string, jest.Mock> } {
  const calls = { list: respond('list') };
  const app = express();
  app.use(express.json());
  app.use('/api/admin', createTemplateCatalogRoutes(calls as unknown as TemplateCatalogController, authMiddleware, permissionsDouble()));
  return { app, calls };
}

describe('createTemplateCatalogRoutes', () => {
  beforeEach(() => { seen.length = 0; });

  it('GET /template-catalog chama o list', async () => {
    const { app, calls } = makeApp();
    const res = await request(app).get('/api/admin/template-catalog');
    expect(res.status).toBe(200);
    expect(calls.list).toHaveBeenCalledTimes(1);
  });

  it('a leitura passa pela guarda de staff', async () => {
    const { app } = makeApp();
    await request(app).get('/api/admin/template-catalog');
    expect(seen).toEqual(['staff GET /template-catalog']);
  });

  it('🔒 NÃO existe rota de escrita — escrita é F2 e depende do lex', async () => {
    const { app } = makeApp();
    for (const m of ['post', 'put', 'patch', 'delete'] as const) {
      const res = await request(app)[m]('/api/admin/template-catalog').send({});
      expect(res.status).toBe(404);
    }
  });
});
