/**
 * funnelStageMessagesRoutes.test.ts — as 2 rotas da config "mensagem por etapa"
 * (DEC-12) sob a guarda certa: leitura é staff, escrita é SÓ admin (lex 29/08 C7).
 * Molde: adminWorkerRoutes.test.ts.
 */
import express from 'express';
import { permissionsDouble } from '@modules/identity/interfaces/middleware/__tests__/permissionFamilyDoubles';
import request from 'supertest';
import { createFunnelStageMessagesRoutes } from '../funnelStageMessagesRoutes';
import type { FunnelStageMessagesController } from '../../controllers/FunnelStageMessagesController';
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
  const calls = { list: respond('list'), update: respond('update') };
  const app = express();
  app.use(express.json());
  app.use('/api/admin', createFunnelStageMessagesRoutes(calls as unknown as FunnelStageMessagesController, authMiddleware, permissionsDouble()));
  return { app, calls };
}

describe('createFunnelStageMessagesRoutes', () => {
  beforeEach(() => { seen.length = 0; papelDoAtor = 'admin'; });

  it('GET /funnel-stage-messages → controller.list sob requireStaff', async () => {
    const { app, calls } = makeApp();
    const res = await request(app).get('/api/admin/funnel-stage-messages');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ handler: 'list' });
    expect(calls.list).toHaveBeenCalledTimes(1);
    expect(calls.update).not.toHaveBeenCalled();
    expect(seen).toEqual(['staff GET /funnel-stage-messages']);
  });

  it('PUT /funnel-stage-messages/:stage → controller.update sob `messaging:write` (quem configura ≠ quem dispara)', async () => {
    const { app, calls } = makeApp();
    const res = await request(app).put('/api/admin/funnel-stage-messages/COMPLETED').send({ template_slug: null, enabled: false });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ handler: 'update' });
    expect(calls.update).toHaveBeenCalledTimes(1);
    expect(calls.list).not.toHaveBeenCalled();
    expect(seen).toEqual(['staff PUT /funnel-stage-messages/COMPLETED']);
  });

  it('PUT com papel que não é admin → 403 enquanto a família não está enforced (untilEnforced)', async () => {
    papelDoAtor = 'recruiter';
    const { app, calls } = makeApp();
    const res = await request(app).put('/api/admin/funnel-stage-messages/COMPLETED').send({ template_slug: null, enabled: false });
    expect(res.status).toBe(403);
    expect(calls.update).not.toHaveBeenCalled();
    expect((await request(app).get('/api/admin/funnel-stage-messages')).status).toBe(200);
  });

  it('verbo fora do contrato (POST/DELETE) não cai em nenhum handler → 404', async () => {
    const { app, calls } = makeApp();
    expect((await request(app).post('/api/admin/funnel-stage-messages')).status).toBe(404);
    expect((await request(app).delete('/api/admin/funnel-stage-messages/COMPLETED')).status).toBe(404);
    expect(calls.list).not.toHaveBeenCalled();
    expect(calls.update).not.toHaveBeenCalled();
  });
});
