/**
 * As rotas do quadro C (Servicio Contratado) — cadeia Fase 10, DX-10.7. Mesmo contrato do
 * `adminTherapeuticProjectsRoutes.test.ts`: varre o router de VERDADE com `scanExpressRouter`
 * (o mesmo que alimenta o catálogo de células) e afirma a célula de cada rota a partir do MAPA
 * escrito à mão (DX-10.1/DX-10.7 + o cabeçalho do router), não do código — senão o teste
 * concordaria com qualquer erro de declaração.
 *
 * ⚠️ Cobre só este router. O oráculo do app inteiro é o e2e `permission-route-inventory`
 * (`BT/permission-route-inventory.test.ts`, P13).
 */
import express from 'express';
import request from 'supertest';
import { scanExpressRouter, cellKey, undeclaredRoutes } from '@modules/identity/permissions';
import { authDouble, permissionsDouble } from '@modules/identity/interfaces/middleware/__tests__/permissionFamilyDoubles';
import { createAdminServiceTeamRoutes } from '../adminServiceTeamRoutes';
import type { AdminServiceTeamController } from '../../controllers/AdminServiceTeamController';

const TEAM_READ = 'patient_services:read';
const TEAM_UPDATE = 'patient_service_team:update';

/** O mapa esperado, escrito à mão a partir da DX-10.1/DX-10.7 e do cabeçalho do router. */
const ESPERADO: Record<string, string> = {
  'GET /patients/:id/contracted-services/:sid/team': TEAM_READ,
  'POST /patients/:id/contracted-services/:sid/team/reject': TEAM_UPDATE,
  'POST /patients/:id/contracted-services/:sid/team/revert': TEAM_UPDATE,
};

/** Cada handler devolve o próprio nome — é o que identifica quem foi chamado (e com que params). */
function controllerDuble(): AdminServiceTeamController {
  const responde = (nome: string) => (req: express.Request, res: express.Response) =>
    res.json({ m: nome, id: req.params.id, sid: req.params.sid });
  return {
    get: responde('get'),
    reject: responde('reject'),
    revert: responde('revert'),
  } as unknown as AdminServiceTeamController;
}

const build = () => createAdminServiceTeamRoutes(controllerDuble(), authDouble(), permissionsDouble());

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/admin', build());
  return a;
}

describe('createAdminServiceTeamRoutes', () => {
  it('TODA rota do router declara célula — nenhuma passa sem declaração', () => {
    expect(undeclaredRoutes(scanExpressRouter(build()), () => true)).toEqual([]);
  });

  it('cada uma das 3 rotas declara a célula do mapa (DX-10.1/DX-10.7)', () => {
    const declarado = Object.fromEntries(
      scanExpressRouter(build()).map((route) => [
        `${route.method} ${route.path}`,
        route.cell ? cellKey(route.cell.resource, route.cell.action) : null,
      ]),
    );
    expect(declarado).toEqual(ESPERADO);
  });

  it('são exatamente 3 rotas: 1 leitura + 2 escritas (rejeitar/reverter) — nenhum POST de adicionar', () => {
    expect(scanExpressRouter(build())).toHaveLength(3);
  });

  it('critério 5: exatamente 1 `router.get(` e 2 `router.post(` — nenhum put/patch/delete', () => {
    const rotas = scanExpressRouter(build());
    expect(rotas.filter((r) => r.method === 'GET')).toHaveLength(1);
    expect(rotas.filter((r) => r.method === 'POST')).toHaveLength(2);
    expect(rotas.map((r) => r.method)).not.toContain('PUT');
    expect(rotas.map((r) => r.method)).not.toContain('PATCH');
    expect(rotas.map((r) => r.method)).not.toContain('DELETE');
  });

  it('a rota é `:sid`, não `:serviceId` — nome das irmãs (Q-EX-10.3)', () => {
    const caminhos = scanExpressRouter(build()).map((r) => r.path);
    for (const p of caminhos) {
      expect(p).toContain(':sid');
      expect(p).not.toContain(':serviceId');
    }
  });

  // Despacho real (supertest): o método certo com `id`/`sid`, no molde adminTherapeuticProjectsRoutes.
  it.each([
    ['get', '/api/admin/patients/abc-123/contracted-services/svc-1/team', 'get'],
    ['post', '/api/admin/patients/abc-123/contracted-services/svc-1/team/reject', 'reject'],
    ['post', '/api/admin/patients/abc-123/contracted-services/svc-1/team/revert', 'revert'],
  ] as const)('%s %s → %s', async (metodo, caminho, esperado) => {
    const res = await request(app())[metodo](caminho).expect(200);
    expect(res.body.m).toBe(esperado);
    expect(res.body.id).toBe('abc-123');
    expect(res.body.sid).toBe('svc-1');
  });

  // Invariante 1: nenhum POST de "adicionar" — a vaga é quem põe candidato, C só rejeita/reverte.
  it.each([
    ['put', '/api/admin/patients/abc-123/contracted-services/svc-1/team'],
    ['patch', '/api/admin/patients/abc-123/contracted-services/svc-1/team'],
    ['delete', '/api/admin/patients/abc-123/contracted-services/svc-1/team'],
    ['post', '/api/admin/patients/abc-123/contracted-services/svc-1/team/add'],
  ] as const)('%s %s → 404 (rota não declarada)', async (metodo, caminho) => {
    await request(app())[metodo](caminho).expect(404);
  });
});
