/**
 * `/v1/me/simulation*` — a porta HTTP da simulação de grupo (spec 026, D407).
 * Molde exato de `meAuthzRoute.test.ts`: o que se afirma aqui é a BORDA — de
 * onde vem o sujeito, o que sai quando o use case recusa, e que o corpo é o
 * shape do contrato (`specs/026-simular-grupo-de-acesso/contracts/me-simulation.md`).
 *
 * A invariante "só o Acesso Master simula" é do BANCO
 * (`iam.start_group_simulation`, mig 458) — aqui só se prova a TRADUÇÃO:
 * `PermissionError('forbidden')` → 403 `not_master_member`;
 * `PermissionError('not_found' | 'system_group')` → 422 `group_not_simulable`.
 */

import express from 'express';
import request from 'supertest';
import { createMeSimulationRouter } from '../meSimulationRoute';
import { ENLITE_TENANT_ID } from '../../domain/tenant';
import { PermissionError } from '../../domain/PermissionError';
import type { ListSimulatableGroupsUseCase } from '../../application/ListSimulatableGroupsUseCase';
import type { PermissionClient, ResolvedAuthz } from '../../application/ports';
import type { StartGroupSimulationUseCase } from '../../application/StartGroupSimulationUseCase';
import type { EndGroupSimulationUseCase } from '../../application/EndGroupSimulationUseCase';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
}));

const UID = 'uid-master';
const GROUP_ID = '22222222-2222-2222-2222-222222222222';

const SIMULACAO = {
  id: 'sim-1',
  groupId: GROUP_ID,
  groupName: 'Recrutamento AR',
  startedAt: new Date('2026-09-22T18:00:00Z'),
  expiresAt: new Date('2026-09-22T22:00:00Z'),
};

function resolvedAuthz(over: Partial<ResolvedAuthz> = {}): ResolvedAuthz {
  return {
    uid: UID,
    tenantId: ENLITE_TENANT_ID,
    status: 'ACTIVE',
    permissions: [],
    countries: [],
    groups: [],
    canSimulate: true,
    simulation: null,
    ...over,
  };
}

function build(
  over: {
    listGroups?: jest.Mock;
    startSimulation?: jest.Mock;
    endSimulation?: jest.Mock;
    resolve?: jest.Mock;
    uid?: string | null;
    staffGuard?: express.RequestHandler;
    /** Omite `tenantId` da montagem — prova o default `ENLITE_TENANT_ID`. */
    semTenantId?: boolean;
  } = {},
) {
  const listGroups = over.listGroups ?? jest.fn().mockResolvedValue([{ id: 'g2', name: 'Recrutamento AR' }]);
  const startSimulation = over.startSimulation ?? jest.fn().mockResolvedValue(SIMULACAO);
  const endSimulation = over.endSimulation ?? jest.fn().mockResolvedValue({ ended: true });
  // Default: ator É membro do Acesso Master — só os testes de 403 sobrescrevem.
  const resolve = over.resolve ?? jest.fn().mockResolvedValue(resolvedAuthz());
  const app = express();
  app.use(express.json());
  app.use(
    '/v1',
    createMeSimulationRouter({
      listGroups: { execute: listGroups } as unknown as ListSimulatableGroupsUseCase,
      startSimulation: { execute: startSimulation } as unknown as StartGroupSimulationUseCase,
      endSimulation: { execute: endSimulation } as unknown as EndGroupSimulationUseCase,
      client: { resolve } as unknown as PermissionClient,
      staffGuard: over.staffGuard ?? ((_req, _res, next) => next()),
      uidOf: () => (over.uid === undefined ? UID : over.uid),
      ...(over.semTenantId ? {} : { tenantId: ENLITE_TENANT_ID }),
    }),
  );
  return { app, listGroups, startSimulation, endSimulation, resolve };
}

describe('GET /v1/me/simulation/groups', () => {
  it('200: grupos simuláveis do tenant — o shape do contrato', async () => {
    const { app, resolve } = build();
    const res = await request(app).get('/v1/me/simulation/groups').expect(200);
    expect(res.body).toEqual([{ id: 'g2', name: 'Recrutamento AR' }]);
    expect(resolve).toHaveBeenCalledWith(UID, ENLITE_TENANT_ID);
  });

  it('403 not_master_member quando canSimulate é false — sem chamar listGroups (nenhuma query extra)', async () => {
    const { app, listGroups } = build({
      resolve: jest.fn().mockResolvedValue(resolvedAuthz({ canSimulate: false })),
    });
    const res = await request(app).get('/v1/me/simulation/groups').expect(403);
    expect(res.body).toEqual({ code: 'not_master_member' });
    expect(listGroups).not.toHaveBeenCalled();
  });

  it('401 sem uid no principal — serviço não tem contrato de simulação', async () => {
    const { app, resolve } = build({ uid: null });
    const res = await request(app).get('/v1/me/simulation/groups').expect(401);
    expect(res.body).toEqual({ success: false, error: 'Unauthenticated' });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('falha ao resolver (erro que não é PermissionError) é 500, não 403/422 mascarado', async () => {
    const { app } = build({ resolve: jest.fn().mockRejectedValue(new Error('cloud sql oscilou')) });
    const res = await request(app).get('/v1/me/simulation/groups').expect(500);
    expect(res.body).toEqual({ success: false, error: 'Failed to list simulatable groups' });
  });

  it('PermissionError vinda do use case (não só do gate canSimulate) também é traduzida — 422 group_not_simulable', async () => {
    const { app } = build({
      listGroups: jest.fn().mockRejectedValue(new PermissionError('not_found', 'x')),
    });
    const res = await request(app).get('/v1/me/simulation/groups').expect(422);
    expect(res.body).toEqual({ code: 'group_not_simulable' });
  });

  it('sem tenantId explícito, usa o default ENLITE_TENANT_ID da casa', async () => {
    const { app, resolve } = build({ semTenantId: true });
    await request(app).get('/v1/me/simulation/groups').expect(200);
    expect(resolve).toHaveBeenCalledWith(UID, ENLITE_TENANT_ID);
  });
});

describe('POST /v1/me/simulation', () => {
  it('201: abre a simulação e devolve o shape do contrato (mesmo do `simulation` em /v1/me/authz)', async () => {
    const { app, startSimulation } = build();
    const res = await request(app).post('/v1/me/simulation').send({ groupId: GROUP_ID }).expect(201);

    expect(res.body).toEqual({
      id: 'sim-1',
      groupId: GROUP_ID,
      groupName: 'Recrutamento AR',
      startedAt: '2026-09-22T18:00:00.000Z',
      expiresAt: '2026-09-22T22:00:00.000Z',
    });
    expect(startSimulation).toHaveBeenCalledWith({ uid: UID, tenantId: ENLITE_TENANT_ID, groupId: GROUP_ID });
  });

  it('o sujeito é o principal autenticado — um `uid` no corpo é ignorado', async () => {
    const { app, startSimulation } = build();
    await request(app).post('/v1/me/simulation').send({ groupId: GROUP_ID, uid: 'uid-de-outra-pessoa' }).expect(201);

    expect(startSimulation).toHaveBeenCalledWith({ uid: UID, tenantId: ENLITE_TENANT_ID, groupId: GROUP_ID });
  });

  it('403 not_master_member', async () => {
    const { app, startSimulation } = build({
      startSimulation: jest.fn().mockRejectedValue(new PermissionError('forbidden', 'x')),
    });
    const res = await request(app).post('/v1/me/simulation').send({ groupId: GROUP_ID }).expect(403);

    expect(res.body).toEqual({ code: 'not_master_member' });
    expect(startSimulation).toHaveBeenCalled();
  });

  it('422 group_not_simulable — grupo inexistente/arquivado/de outro tenant (not_found)', async () => {
    const { app } = build({ startSimulation: jest.fn().mockRejectedValue(new PermissionError('not_found', 'x')) });
    const res = await request(app).post('/v1/me/simulation').send({ groupId: GROUP_ID }).expect(422);
    expect(res.body).toEqual({ code: 'group_not_simulable' });
  });

  it('422 group_not_simulable — o alvo é o próprio Acesso Master (system_group)', async () => {
    const { app } = build({ startSimulation: jest.fn().mockRejectedValue(new PermissionError('system_group', 'x')) });
    const res = await request(app)
      .post('/v1/me/simulation')
      .send({ groupId: 'a0000000-0000-0000-0000-000000000001' })
      .expect(422);
    expect(res.body).toEqual({ code: 'group_not_simulable' });
  });

  it('body sem groupId válido nem chega ao use case', async () => {
    const { app, startSimulation } = build();
    const res = await request(app).post('/v1/me/simulation').send({}).expect(400);

    expect(startSimulation).not.toHaveBeenCalled();
    expect(res.body).toEqual({ success: false, error: 'Invalid simulation payload' });
  });

  it('groupId que não é uuid também é 400', async () => {
    const { app, startSimulation } = build();
    await request(app).post('/v1/me/simulation').send({ groupId: 'não-é-uuid' }).expect(400);
    expect(startSimulation).not.toHaveBeenCalled();
  });

  it('401 sem uid no principal', async () => {
    const { app, startSimulation } = build({ uid: null });
    const res = await request(app).post('/v1/me/simulation').send({ groupId: GROUP_ID }).expect(401);
    expect(res.body).toEqual({ success: false, error: 'Unauthenticated' });
    expect(startSimulation).not.toHaveBeenCalled();
  });

  it('PermissionError com código que esta rota não traduz (ex.: invalid_input) cai no 500 genérico', async () => {
    const { app } = build({
      startSimulation: jest.fn().mockRejectedValue(new PermissionError('invalid_input', 'x')),
    });
    const res = await request(app).post('/v1/me/simulation').send({ groupId: GROUP_ID }).expect(500);
    expect(res.body).toEqual({ success: false, error: 'Failed to start simulation' });
  });

  it('erro que não é PermissionError (ex.: banco fora) também é 500 genérico', async () => {
    const { app } = build({ startSimulation: jest.fn().mockRejectedValue(new Error('banco fora')) });
    const res = await request(app).post('/v1/me/simulation').send({ groupId: GROUP_ID }).expect(500);
    expect(res.body).toEqual({ success: false, error: 'Failed to start simulation' });
  });
});

describe('DELETE /v1/me/simulation', () => {
  it('204 encerra a simulação aberta do ator', async () => {
    const { app, endSimulation } = build();
    await request(app).delete('/v1/me/simulation').expect(204);
    expect(endSimulation).toHaveBeenCalledWith({ uid: UID, tenantId: ENLITE_TENANT_ID });
  });

  it('204 idempotente — chamar duas vezes sem simulação aberta não falha', async () => {
    const endSimulation = jest.fn().mockResolvedValue({ ended: false });
    const { app } = build({ endSimulation });

    await request(app).delete('/v1/me/simulation').expect(204);
    await request(app).delete('/v1/me/simulation').expect(204);

    expect(endSimulation).toHaveBeenCalledTimes(2);
  });

  it('401 sem uid no principal', async () => {
    const { app, endSimulation } = build({ uid: null });
    const res = await request(app).delete('/v1/me/simulation').expect(401);
    expect(res.body).toEqual({ success: false, error: 'Unauthenticated' });
    expect(endSimulation).not.toHaveBeenCalled();
  });

  it('erro que não é PermissionError é 500 genérico (nunca 204 silencioso)', async () => {
    const { app } = build({ endSimulation: jest.fn().mockRejectedValue(new Error('banco fora')) });
    const res = await request(app).delete('/v1/me/simulation').expect(500);
    expect(res.body).toEqual({ success: false, error: 'Failed to end simulation' });
  });

  it('PermissionError do use case também é traduzida aqui — mesmo tradutor das outras duas rotas', async () => {
    const { app } = build({
      endSimulation: jest.fn().mockRejectedValue(new PermissionError('forbidden', 'x')),
    });
    const res = await request(app).delete('/v1/me/simulation').expect(403);
    expect(res.body).toEqual({ code: 'not_master_member' });
  });
});

describe('perímetro de deny-by-default (denyUndeclaredRoutes)', () => {
  it('as 3 rotas NÃO declaram célula — isentas NA MONTAGEM, molde meAuthzRoute.ts:57 (D116)', () => {
    const { app } = build();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { scanExpressRouter } = require('@modules/identity/permissions') as typeof import('@modules/identity/permissions');

    const rotas = scanExpressRouter(app as unknown as Parameters<typeof scanExpressRouter>[0]);
    const porPath = (path: string) => rotas.find((r) => r.path.endsWith(path));

    for (const path of ['/me/simulation/groups', '/me/simulation']) {
      const rota = porPath(path);
      expect(rota).toBeDefined();
      expect(rota?.cell).toBeUndefined();
      expect(rota?.exempt?.reason).toContain('self');
    }
  });
});
