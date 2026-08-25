/**
 * `GET /v1/me/authz` — a porta HTTP do contrato agregado.
 *
 * O que este arquivo mede que o teste do `GetMyAuthzUseCase` NÃO media: o use
 * case já tinha suíte desde o grupo 2, mas ninguém exercitava a rota — ela não
 * existia. Aqui a afirmação é sobre a BORDA: de onde vem o sujeito, o que sai
 * quando o resolve falha, e que o corpo é o contrato inteiro.
 */

import express from 'express';
import request from 'supertest';
import { createMeAuthzRouter } from '../meAuthzRoute';
import { ENLITE_TENANT_ID } from '../../domain/tenant';
import type { GetMyAuthzUseCase } from '../../application/GetMyAuthzUseCase';
import type { AuthzContract } from '../../application/ports';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
}));

const CONTRATO: AuthzContract = {
  uid: 'uid-gestora',
  tenantId: ENLITE_TENANT_ID,
  status: 'ACTIVE',
  permissions: ['worker:read', 'funnel:read'],
  countries: ['AR'],
  groups: [{ id: 'g1', name: 'Recrutamento AR' }],
  features: { AR: { 'screen:access': { enabled: true, config: null } } },
};

function build(over: { execute?: jest.Mock; uid?: string | null; tenantId?: string } = {}) {
  const execute = over.execute ?? jest.fn().mockResolvedValue(CONTRATO);
  const app = express();
  app.use(
    '/v1',
    createMeAuthzRouter({
      getMyAuthz: { execute } as unknown as GetMyAuthzUseCase,
      staffGuard: (_req, _res, next) => next(),
      uidOf: () => (over.uid === undefined ? 'uid-gestora' : over.uid),
      tenantId: over.tenantId,
    }),
  );
  return { app, execute };
}

describe('GET /v1/me/authz', () => {
  it('devolve o contrato agregado INTEIRO — o front decide tudo com uma resposta só', async () => {
    const { app } = build();

    const res = await request(app).get('/v1/me/authz').expect(200);

    expect(res.body).toEqual(CONTRATO);
    expect(Object.keys(res.body).sort()).toEqual([
      'countries',
      'features',
      'groups',
      'permissions',
      'status',
      'tenantId',
      'uid',
    ]);
  });

  it('o sujeito é o principal autenticado — nunca o path, nunca a query', async () => {
    const { app, execute } = build();

    await request(app).get('/v1/me/authz?uid=uid-de-outra-pessoa').expect(200);

    expect(execute).toHaveBeenCalledWith({ uid: 'uid-gestora', tenantId: ENLITE_TENANT_ID });
  });

  it('sem uid no principal responde 401 — serviço não tem contrato de painel', async () => {
    const { app, execute } = build({ uid: null });

    const res = await request(app).get('/v1/me/authz').expect(401);

    expect(res.body).toEqual({ success: false, error: 'Unauthenticated' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('falha ao resolver é 500, NÃO contrato vazio (vazio = "sem grupo" na tela)', async () => {
    const { app } = build({ execute: jest.fn().mockRejectedValue(new Error('cloud sql oscilou')) });

    const res = await request(app).get('/v1/me/authz').expect(500);

    expect(res.body).toEqual({ success: false, error: 'Failed to resolve authorization' });
    expect(res.body.permissions).toBeUndefined();
    expect(res.body.groups).toBeUndefined();
  });

  it('o tenant é injetável, e o default é o da casa', async () => {
    const { app, execute } = build({ tenantId: 'tenant-de-teste' });

    await request(app).get('/v1/me/authz').expect(200);

    expect(execute).toHaveBeenCalledWith({ uid: 'uid-gestora', tenantId: 'tenant-de-teste' });
  });

  it('a rota NÃO declara célula — self não é decisão de staff (D116)', () => {
    const { app } = build();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { scanExpressRouter } = require('@modules/identity/permissions') as typeof import('@modules/identity/permissions');

    const rotas = scanExpressRouter(app as unknown as Parameters<typeof scanExpressRouter>[0]);
    const authz = rotas.find((r) => r.path.endsWith('/me/authz'));

    expect(authz).toBeDefined();
    expect(authz?.cell).toBeUndefined();
  });
});
