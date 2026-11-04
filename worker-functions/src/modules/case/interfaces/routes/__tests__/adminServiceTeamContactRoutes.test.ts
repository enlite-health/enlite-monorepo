/**
 * As rotas do modal do prestador (quadro C — rodada 2, decisão D). Mesmo contrato do irmão
 * `adminServiceTeamRoutes.test.ts`: varre o router de VERDADE com `scanExpressRouter` e afirma a
 * célula de cada rota a partir do MAPA escrito à mão, não do código.
 */
import express from 'express';
import request from 'supertest';
import { scanExpressRouter, cellKey, undeclaredRoutes } from '@modules/identity/permissions';
import { authDouble, permissionsDouble } from '@modules/identity/interfaces/middleware/__tests__/permissionFamilyDoubles';
import { createAdminServiceTeamContactRoutes } from '../adminServiceTeamContactRoutes';
import type { AdminServiceTeamContactController } from '../../controllers/AdminServiceTeamContactController';

const TEAM_READ = 'patient_services:read';
const TEAM_UPDATE = 'patient_service_team:update';

const ESPERADO: Record<string, string> = {
  'GET /patients/:id/contracted-services/:sid/team/:workerId/contact': TEAM_READ,
  'POST /patients/:id/contracted-services/:sid/team/:workerId/contact': TEAM_UPDATE,
};

function controllerDuble(): AdminServiceTeamContactController {
  const responde = (nome: string) => (req: express.Request, res: express.Response) =>
    res.json({ m: nome, id: req.params.id, sid: req.params.sid, workerId: req.params.workerId });
  return { get: responde('get'), register: responde('register') } as unknown as AdminServiceTeamContactController;
}

const build = () => createAdminServiceTeamContactRoutes(controllerDuble(), authDouble(), permissionsDouble());

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/admin', build());
  return a;
}

describe('createAdminServiceTeamContactRoutes', () => {
  it('TODA rota do router declara célula — nenhuma passa sem declaração', () => {
    expect(undeclaredRoutes(scanExpressRouter(build()), () => true)).toEqual([]);
  });

  it('cada uma das 2 rotas declara a célula do mapa', () => {
    const declarado = Object.fromEntries(
      scanExpressRouter(build()).map((route) => [
        `${route.method} ${route.path}`,
        route.cell ? cellKey(route.cell.resource, route.cell.action) : null,
      ]),
    );
    expect(declarado).toEqual(ESPERADO);
  });

  it('são exatamente 2 rotas: 1 leitura + 1 escrita (registrar contato)', () => {
    expect(scanExpressRouter(build())).toHaveLength(2);
  });

  it('critério: exatamente 1 `router.get(` e 1 `router.post(` — nenhum put/patch/delete', () => {
    const rotas = scanExpressRouter(build());
    expect(rotas.filter((r) => r.method === 'GET')).toHaveLength(1);
    expect(rotas.filter((r) => r.method === 'POST')).toHaveLength(1);
    expect(rotas.map((r) => r.method)).not.toContain('PUT');
    expect(rotas.map((r) => r.method)).not.toContain('PATCH');
    expect(rotas.map((r) => r.method)).not.toContain('DELETE');
  });

  it('a rota é `:sid`/`:workerId`, não `:serviceId` (mesmo molde do irmão, Q-EX-10.3)', () => {
    const caminhos = scanExpressRouter(build()).map((r) => r.path);
    for (const p of caminhos) {
      expect(p).toContain(':sid');
      expect(p).toContain(':workerId');
      expect(p).not.toContain(':serviceId');
    }
  });

  it.each([
    ['get', '/api/admin/patients/abc-123/contracted-services/svc-1/team/w-1/contact', 'get'],
    ['post', '/api/admin/patients/abc-123/contracted-services/svc-1/team/w-1/contact', 'register'],
  ] as const)('%s %s → %s', async (metodo, caminho, esperado) => {
    const res = await request(app())[metodo](caminho).expect(200);
    expect(res.body.m).toBe(esperado);
    expect(res.body.id).toBe('abc-123');
    expect(res.body.sid).toBe('svc-1');
    expect(res.body.workerId).toBe('w-1');
  });

  it.each([
    ['put', '/api/admin/patients/abc-123/contracted-services/svc-1/team/w-1/contact'],
    ['patch', '/api/admin/patients/abc-123/contracted-services/svc-1/team/w-1/contact'],
    ['delete', '/api/admin/patients/abc-123/contracted-services/svc-1/team/w-1/contact'],
  ] as const)('%s %s → 404 (rota não declarada — append-only, sem update/delete)', async (metodo, caminho) => {
    await request(app())[metodo](caminho).expect(404);
  });
});
