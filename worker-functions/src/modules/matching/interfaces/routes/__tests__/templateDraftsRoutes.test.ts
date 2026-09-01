/**
 * As rotas do rascunho (spec 010, F2 passos 2.1 e 2.2).
 *
 * Dois contratos travados aqui:
 *
 * 1. **Escrita é `requireAdmin`, leitura é `requireStaff`.** Precedente do
 *    parecer `lex` de 29/08, condição C7 — quem configura ≠ quem dispara. Uma
 *    escrita que virasse staff passaria despercebida sem este teste.
 * 2. **`/submit` e `/duplicate` existem e são ADMIN.** A submissão escreve para
 *    fora do perímetro; o parecer do `lex` NÃO foi emitido (decisão do Gabriel,
 *    31/08/2026) e a rota sobe desligada por flag. Aqui travamos ao menos que
 *    ela nunca fique atrás de `staff`.
 *
 * Molde: templateCatalogRoutes.test.ts.
 */
import express from 'express';
import request from 'supertest';
import { createTemplateDraftsRoutes } from '../templateDraftsRoutes';
import type { TemplateDraftsController } from '../../controllers/TemplateDraftsController';
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
  const calls = {
    list: respond('list'),
    create: respond('create'),
    update: respond('update'),
    archive: respond('archive'),
    submit: respond('submit'),
    duplicate: respond('duplicate'),
  };
  const app = express();
  app.use(express.json());
  app.use('/api/admin', createTemplateDraftsRoutes(calls as unknown as TemplateDraftsController, authMiddleware));
  return { app, calls };
}

describe('createTemplateDraftsRoutes', () => {
  beforeEach(() => { seen.length = 0; });

  it('GET /template-drafts chama o list, atrás de staff', async () => {
    const { app, calls } = makeApp();
    const res = await request(app).get('/api/admin/template-drafts');
    expect(res.status).toBe(200);
    expect(calls.list).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['staff GET /template-drafts']);
  });

  it('POST /template-drafts chama o create, atrás de ADMIN', async () => {
    const { app, calls } = makeApp();
    const res = await request(app).post('/api/admin/template-drafts').send({});
    expect(res.status).toBe(200);
    expect(calls.create).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['admin POST /template-drafts']);
  });

  it('PUT /template-drafts/:id chama o update, atrás de ADMIN', async () => {
    const { app, calls } = makeApp();
    const res = await request(app).put('/api/admin/template-drafts/abc').send({});
    expect(res.status).toBe(200);
    expect(calls.update).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['admin PUT /template-drafts/abc']);
  });

  it('DELETE /template-drafts/:id chama o archive, atrás de ADMIN', async () => {
    const { app, calls } = makeApp();
    const res = await request(app).delete('/api/admin/template-drafts/abc');
    expect(res.status).toBe(200);
    expect(calls.archive).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['admin DELETE /template-drafts/abc']);
  });

  it('POST /template-drafts/:id/submit chama o submit, atrás de ADMIN', async () => {
    const { app, calls } = makeApp();
    const res = await request(app).post('/api/admin/template-drafts/abc/submit').send({ confirmado: true });
    expect(res.status).toBe(200);
    expect(calls.submit).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['admin POST /template-drafts/abc/submit']);
  });

  it('POST /template-drafts/:id/duplicate chama o duplicate, atrás de ADMIN', async () => {
    const { app, calls } = makeApp();
    const res = await request(app).post('/api/admin/template-drafts/abc/duplicate').send({});
    expect(res.status).toBe(200);
    expect(calls.duplicate).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['admin POST /template-drafts/abc/duplicate']);
  });

  it('🔒 a submissão NUNCA fica atrás de staff — é a rota irreversível', async () => {
    const { app } = makeApp();
    await request(app).post('/api/admin/template-drafts/abc/submit').send({ confirmado: true });
    expect(seen.filter((s) => s.startsWith('staff'))).toEqual([]);
  });

  it('🔒 nenhuma escrita passa por staff — só leitura é staff', async () => {
    const { app } = makeApp();
    await request(app).post('/api/admin/template-drafts').send({});
    await request(app).put('/api/admin/template-drafts/a').send({});
    await request(app).delete('/api/admin/template-drafts/a');
    await request(app).post('/api/admin/template-drafts/a/submit').send({ confirmado: true });
    await request(app).post('/api/admin/template-drafts/a/duplicate').send({});
    expect(seen.filter((s) => s.startsWith('staff'))).toEqual([]);
    expect(seen).toHaveLength(5);
  });
});
