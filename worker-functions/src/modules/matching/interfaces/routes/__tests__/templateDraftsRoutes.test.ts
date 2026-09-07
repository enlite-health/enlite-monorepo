/**
 * As rotas do rascunho (spec 010, F2 passos 2.1 e 2.2).
 *
 * Dois contratos travados aqui:
 *
 * 1. **TUDO era `requireAdmin`, inclusive a leitura.** Decisão do Gabriel em
 *    01/09/2026. O menu já filtrava por `isAdmin`, mas menu não é controle de
 *    acesso — sem este teste, um staff chamaria a API direto e veria tudo.
 *    Desde 07/09 o papel não é nível: a célula `messaging:*` decide, e o que
 *    era admin-only vai em `untilEnforced: 'admin'` — vale enquanto a família
 *    não está enforced, que é o estado destes testes (engine desligado).
 * 2. **`/submit` e `/duplicate` existem e são ADMIN até a família virar.** A
 *    submissão escreve para fora do perímetro; o parecer do `lex` NÃO foi
 *    emitido (decisão do Gabriel, 31/08/2026) e a rota sobe desligada por flag.
 *    Aqui travamos ao menos que ela nunca fique aberta a outro papel.
 *
 * Molde: templateCatalogRoutes.test.ts.
 */
import express from 'express';
import { permissionsDouble } from '@modules/identity/interfaces/middleware/__tests__/permissionFamilyDoubles';
import request from 'supertest';
import { createTemplateDraftsRoutes } from '../templateDraftsRoutes';
import type { TemplateDraftsController } from '../../controllers/TemplateDraftsController';
import type { AuthMiddleware } from '@modules/identity';

const respond = (name: string): jest.Mock =>
  jest.fn((_req: express.Request, res: express.Response) => { res.status(200).json({ handler: name }); });

const seen: string[] = [];
// O dublê pendura o papel que o `requireStaff` real penduraria: é o que o
// `untilEnforced: 'admin'` do PermissionMiddleware lê com o engine desligado.
let papelDoAtor = 'admin';
const guard = (label: string) => (req: express.Request, _res: express.Response, next: express.NextFunction) => {
  seen.push(`${label} ${req.method} ${req.path}`);
  req.authContext = { principal: { id: 'ator', roles: [papelDoAtor] } } as never;
  next();
};
const authMiddleware = { requireStaff: () => guard('staff') } as unknown as AuthMiddleware;

function makeApp(): { app: express.Express; calls: Record<string, jest.Mock> } {
  const calls = {
    list: respond('list'),
    create: respond('create'),
    validar: respond('validar'),
    update: respond('update'),
    archive: respond('archive'),
    submit: respond('submit'),
    duplicate: respond('duplicate'),
  };
  const app = express();
  app.use(express.json());
  app.use('/api/admin', createTemplateDraftsRoutes(calls as unknown as TemplateDraftsController, authMiddleware, permissionsDouble()));
  return { app, calls };
}

describe('createTemplateDraftsRoutes', () => {
  beforeEach(() => { seen.length = 0; papelDoAtor = 'admin'; });

  it('GET /template-drafts chama o list, atrás de ADMIN', async () => {
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
    expect(seen).toEqual(['staff POST /template-drafts']);
  });

  it('PUT /template-drafts/:id chama o update, atrás de ADMIN', async () => {
    const { app, calls } = makeApp();
    const res = await request(app).put('/api/admin/template-drafts/abc').send({});
    expect(res.status).toBe(200);
    expect(calls.update).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['staff PUT /template-drafts/abc']);
  });

  it('DELETE /template-drafts/:id chama o archive, atrás de ADMIN', async () => {
    const { app, calls } = makeApp();
    const res = await request(app).delete('/api/admin/template-drafts/abc');
    expect(res.status).toBe(200);
    expect(calls.archive).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['staff DELETE /template-drafts/abc']);
  });

  it('POST /template-drafts/:id/submit chama o submit, atrás de ADMIN', async () => {
    const { app, calls } = makeApp();
    const res = await request(app).post('/api/admin/template-drafts/abc/submit').send({ confirmado: true });
    expect(res.status).toBe(200);
    expect(calls.submit).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['staff POST /template-drafts/abc/submit']);
  });

  it('POST /template-drafts/:id/duplicate chama o duplicate, atrás de ADMIN', async () => {
    const { app, calls } = makeApp();
    const res = await request(app).post('/api/admin/template-drafts/abc/duplicate').send({});
    expect(res.status).toBe(200);
    expect(calls.duplicate).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['staff POST /template-drafts/abc/duplicate']);
  });

  it('POST /template-drafts/validar chama o validar (antes do PUT dinâmico /:id)', async () => {
    const { app, calls } = makeApp();
    const res = await request(app).post('/api/admin/template-drafts/validar').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ handler: 'validar' });
    expect(calls.validar).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['staff POST /template-drafts/validar']);
  });

  it('🔒 a submissão NUNCA fica aberta a outro papel — é a rota irreversível', async () => {
    papelDoAtor = 'recruiter';
    const { app, calls } = makeApp();
    const res = await request(app).post('/api/admin/template-drafts/abc/submit').send({ confirmado: true });
    expect(res.status).toBe(403);
    expect(calls.submit).not.toHaveBeenCalled();
  });

  it('🔒 NENHUMA rota aceita outro papel — nem a leitura', async () => {
    papelDoAtor = 'community_manager';
    const { app, calls } = makeApp();
    const statuses = [
      (await request(app).get('/api/admin/template-drafts')).status,
      (await request(app).post('/api/admin/template-drafts').send({})).status,
      (await request(app).put('/api/admin/template-drafts/a').send({})).status,
      (await request(app).delete('/api/admin/template-drafts/a')).status,
      (await request(app).post('/api/admin/template-drafts/a/submit').send({ confirmado: true })).status,
      (await request(app).post('/api/admin/template-drafts/a/duplicate').send({})).status,
    ];
    expect(statuses).toEqual([403, 403, 403, 403, 403, 403]);
    expect(Object.values(calls).every((c) => c.mock.calls.length === 0)).toBe(true);
    expect(seen).toHaveLength(6);
  });
});
