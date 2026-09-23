/**
 * AuthMiddleware.effectiveAuthz.test.ts
 *
 * A resolução das permissões efetivas na AUTENTICAÇÃO (task 3.1). Duas
 * propriedades que parecem detalhe e não são:
 *
 *  · resolver aqui NÃO nega. Conta em admissão e staff sem grupo precisam
 *    autenticar para cair na tela de boas-vindas e no `/auth/profile` do 1º
 *    login. Quem nega é o `PermissionMiddleware`, na rota que exige célula.
 *  · falha de resolução não derruba a autenticação — mas também não vira
 *    permissão: o principal segue sem as listas e o guard da rota nega.
 */

import type { Request, Response, NextFunction } from 'express';
import { AuthMiddleware } from '../AuthMiddleware';
import { loggingAls } from '@shared/logging';
import type { DbSession } from '@shared/database/requestDbSession';
import type { PermissionClient, ResolvedAuthz } from '@modules/identity/permissions';

const ORIGINAL = { mock: process.env.USE_MOCK_AUTH, engine: process.env.PERMISSION_ENGINE_ENABLED };

function resolved(over: Partial<ResolvedAuthz> = {}): ResolvedAuthz {
  return {
    uid: 'u1',
    tenantId: 'tenant',
    status: 'ACTIVE',
    permissions: ['user_management:read'],
    countries: ['AR'],
    groups: [{ id: 'g1', name: 'Recrutador' }],
    canSimulate: false,
    simulation: null,
    ...over,
  };
}

function clientStub(result: ResolvedAuthz | Error = resolved()): PermissionClient {
  return {
    resolve: result instanceof Error ? jest.fn().mockRejectedValue(result) : jest.fn().mockResolvedValue(result),
    can: jest.fn(),
    isFeatureAvailable: jest.fn(),
    featureConfig: jest.fn(),
    invalidate: jest.fn(),
  };
}

async function autenticar(
  user: Record<string, unknown>,
  client?: PermissionClient,
): Promise<Request> {
  const req = { headers: {}, ip: '127.0.0.1', path: '/api/admin/users', method: 'GET', user } as unknown as Request;
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as unknown as Response;
  const next = jest.fn() as NextFunction;
  const middleware = new AuthMiddleware({} as never, {} as never, client).requireAuth();
  const session: DbSession = { released: false };
  await loggingAls.run({ traceId: 't', dbSession: session }, () => middleware(req, res, next));
  expect(next).toHaveBeenCalled();
  return req;
}

describe('AuthMiddleware — permissões efetivas no principal', () => {
  beforeAll(() => {
    process.env.USE_MOCK_AUTH = 'true';
  });
  afterAll(() => {
    if (ORIGINAL.mock === undefined) delete process.env.USE_MOCK_AUTH;
    else process.env.USE_MOCK_AUTH = ORIGINAL.mock;
  });
  afterEach(() => {
    if (ORIGINAL.engine === undefined) delete process.env.PERMISSION_ENGINE_ENABLED;
    else process.env.PERMISSION_ENGINE_ENABLED = ORIGINAL.engine;
    jest.clearAllMocks();
  });

  it('com o engine LIGADO, staff chega com permissions e countries no principal', async () => {
    process.env.PERMISSION_ENGINE_ENABLED = 'true';
    const client = clientStub();

    const req = await autenticar({ uid: 'u1', role: 'recruiter', country: 'AR' }, client);

    expect(req.authContext?.principal).toMatchObject({
      permissions: ['user_management:read'],
      countries: ['AR'],
    });
    expect(client.resolve).toHaveBeenCalledWith('u1', expect.stringMatching(/^0{8}-/));
  });

  it('com o engine DESLIGADO não resolve nada (nenhuma consulta por request)', async () => {
    delete process.env.PERMISSION_ENGINE_ENABLED;
    const client = clientStub();

    const req = await autenticar({ uid: 'u1', role: 'admin' }, client);

    expect(client.resolve).not.toHaveBeenCalled();
    expect(req.authContext?.principal.permissions).toBeUndefined();
  });

  it('prestador não resolve permissão de staff', async () => {
    process.env.PERMISSION_ENGINE_ENABLED = 'true';
    const client = clientStub();

    await autenticar({ uid: 'w1', role: 'worker' }, client);

    expect(client.resolve).not.toHaveBeenCalled();
  });

  it('sem cliente injetado, o middleware se comporta como antes', async () => {
    process.env.PERMISSION_ENGINE_ENABLED = 'true';
    const req = await autenticar({ uid: 'u1', role: 'admin' });
    expect(req.authContext?.principal.permissions).toBeUndefined();
  });

  it('staff sem grupo AUTENTICA (é assim que ele chega na tela de boas-vindas)', async () => {
    process.env.PERMISSION_ENGINE_ENABLED = 'true';
    const client = clientStub(resolved({ groups: [], permissions: [] }));

    const req = await autenticar({ uid: 'u1', role: 'recruiter' }, client);

    expect(req.authContext?.principal.permissions).toEqual([]);
  });

  it('falha ao resolver não derruba a autenticação — e não vira permissão', async () => {
    process.env.PERMISSION_ENGINE_ENABLED = 'true';
    const client = clientStub(new Error('banco fora'));

    const req = await autenticar({ uid: 'u1', role: 'admin' }, client);

    expect(req.authContext?.principal.permissions).toBeUndefined();
  });
});
