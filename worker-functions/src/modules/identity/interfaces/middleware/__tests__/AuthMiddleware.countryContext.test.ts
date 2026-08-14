/**
 * AuthMiddleware.countryContext.test.ts
 *
 * O teste dedicado exigido pela condição C3 do `lex`: **claim `country` ausente
 * NUNCA vira 'AR'**. Um default aqui daria a jurisdição argentina inteira a
 * qualquer operador sem claim, calado — pior do que não ter isolamento nenhum.
 * Sem claim, a request segue sem país e a policy devolve zero linha.
 */

import type { Request, Response, NextFunction } from 'express';
import { AuthMiddleware } from '../AuthMiddleware';
import { loggingAls } from '@shared/logging';
import type { DbSession } from '@shared/database/requestDbSession';

const ORIGINAL_MOCK_AUTH = process.env.USE_MOCK_AUTH;

function makeReqRes(user: Record<string, unknown>): [Request, Response, NextFunction] {
  const req = { headers: {}, ip: '127.0.0.1', path: '/api/admin/patients', method: 'GET', user } as unknown as Request;
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as unknown as Response;
  return [req, res, jest.fn() as NextFunction];
}

/** Roda o requireAuth dentro de uma sessão de banco e devolve o contexto declarado. */
async function contextAfterAuth(user: Record<string, unknown>): Promise<DbSession['context']> {
  const session: DbSession = { released: false };
  const middleware = new AuthMiddleware({} as never, {} as never).requireAuth();
  const [req, res, next] = makeReqRes(user);
  await loggingAls.run({ traceId: 't', dbSession: session }, () => middleware(req, res, next));
  expect(next).toHaveBeenCalled();
  return session.context;
}

describe('AuthMiddleware — contexto de país da request', () => {
  beforeAll(() => {
    process.env.USE_MOCK_AUTH = 'true';
  });
  afterAll(() => {
    if (ORIGINAL_MOCK_AUTH === undefined) delete process.env.USE_MOCK_AUTH;
    else process.env.USE_MOCK_AUTH = ORIGINAL_MOCK_AUTH;
  });

  it('staff com claim AR → contexto de staff com país', async () => {
    expect(await contextAfterAuth({ uid: 'u1', email: 'flor@enlite.health', role: 'admin', country: 'AR' })).toEqual({
      kind: 'staff',
      uid: 'u1',
      country: 'AR',
    });
  });

  it('staff com claim BR → BR (o país sai do claim, não de default nenhum)', async () => {
    expect(await contextAfterAuth({ uid: 'u2', email: 'x@enlite.health', role: 'recruiter', country: 'BR' })).toEqual({
      kind: 'staff',
      uid: 'u2',
      country: 'BR',
    });
  });

  it('[lex C3] staff SEM claim → contexto sem país (nunca AR)', async () => {
    const context = await contextAfterAuth({ uid: 'u3', email: 'y@enlite.health', role: 'recruiter' });
    expect(context?.kind).toBe('staff');
    expect(context?.country).toBeUndefined();
  });

  it('[lex C3] claim inválido (minúsculo, país fora da lista) também não vira AR', async () => {
    expect((await contextAfterAuth({ uid: 'u4', role: 'admin', country: 'ar' }))?.country).toBeUndefined();
    expect((await contextAfterAuth({ uid: 'u5', role: 'admin', country: 'US' }))?.country).toBeUndefined();
    expect((await contextAfterAuth({ uid: 'u6', role: 'admin', country: 42 }))?.country).toBeUndefined();
  });

  it('prestador autenticado é worker-self, não staff — e não carrega país', async () => {
    expect(await contextAfterAuth({ uid: 'w1', email: 'p@x.com', role: 'worker', country: 'AR' })).toEqual({
      kind: 'worker_self',
      uid: 'w1',
    });
  });
});
