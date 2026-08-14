/**
 * AuthMiddleware — classificação de banco das rotas NÃO cobertas pelo
 * `requireAuth` puro (ABAC país, review do gate).
 *
 * O que estes testes travam:
 *  - `requireStaffOrApiKey` com Firebase carimba ATOR (trilha `changed_by`) E
 *    contexto de país — é o caminho do painel, e sem ele a medição de D95 fica
 *    anônima e a RLS sem jurisdição;
 *  - chave de API é SISTEMA nos dois middlewares (`requireStaffOrApiKey` e
 *    `requireApiKey`): serviço não é pessoa, não herda país de ninguém. Sem o
 *    carimbo, o `requireApiKey` classificaria o parceiro como `worker_self` —
 *    fail-closed sob RLS, isto é, zero linha e nenhum erro visível.
 */

import type { Request, Response, NextFunction } from 'express';
import { AuthMiddleware } from '../AuthMiddleware';
import { MultiAuthService } from '../../../infrastructure/MultiAuthService';
import { PrincipalType, CredentialType, type AuthContext } from '../../../domain/Auth';
import { loggingAls, logger } from '@shared/logging';
import type { DbSession } from '@shared/database/requestDbSession';
import type { LogContext } from '@shared/logging/als';

jest.mock('../../../infrastructure/MultiAuthService');

const ORIGINAL_MOCK_AUTH = process.env.USE_MOCK_AUTH;

afterEach(() => {
  if (ORIGINAL_MOCK_AUTH === undefined) delete process.env.USE_MOCK_AUTH;
  else process.env.USE_MOCK_AUTH = ORIGINAL_MOCK_AUTH;
});

function makeReqRes(overrides: Partial<Request> = {}): [Request, Response, NextFunction] {
  const req = {
    headers: {},
    ip: '127.0.0.1',
    path: '/api/admin/workers',
    method: 'GET',
    ...overrides,
  } as unknown as Request;
  const res = {
    status: jest.fn().mockReturnThis(),
    end: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return [req, res, jest.fn() as NextFunction];
}

/** Roda o middleware numa request com sessão de banco e devolve o store do ALS. */
async function runWithSession(
  middleware: (req: Request, res: Response, next: NextFunction) => Promise<void>,
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<LogContext> {
  const session: DbSession = { released: false };
  const store: LogContext = { traceId: 't', dbSession: session };
  await loggingAls.run(store, () => middleware(req, res, next));
  return store;
}

function multiAuthDouble(): jest.Mocked<MultiAuthService> {
  const service = new (MultiAuthService as unknown as new () => MultiAuthService)() as jest.Mocked<MultiAuthService>;
  // `instanceof MultiAuthService` decide o caminho dentro do middleware.
  Object.setPrototypeOf(service, MultiAuthService.prototype);
  return service;
}

const apiKeyContext: AuthContext = {
  principal: { id: 'service:triage', type: PrincipalType.SERVICE, roles: [] },
  credentials: { type: CredentialType.API_KEY, token: 'key123', scopes: [] },
  metadata: { ipAddress: '127.0.0.1', requestId: 'r1', timestamp: new Date(), path: '', method: '' },
};

describe('requireStaffOrApiKey — ator e contexto', () => {
  it('staff Firebase com claim de país carimba ATOR e contexto de staff', async () => {
    const multiAuth = multiAuthDouble();
    multiAuth.tryAuthenticateAsApiKey = jest.fn().mockReturnValue(null);
    multiAuth.authenticateGoogleIdToken = jest.fn().mockResolvedValue({
      principal: { id: 'uid-flor', type: PrincipalType.USER, roles: ['recruiter'], country: 'BR' },
      credentials: { type: CredentialType.GOOGLE_ID_TOKEN, token: 't', scopes: [] },
      metadata: { ipAddress: '127.0.0.1', requestId: 'r2', timestamp: new Date(), path: '', method: '' },
    });
    const middleware = new AuthMiddleware(multiAuth, {} as never).requireStaffOrApiKey();
    const [req, res, next] = makeReqRes({ headers: { authorization: 'Bearer firebase-token' } });

    const store = await runWithSession(middleware, req, res, next);

    expect(next).toHaveBeenCalled();
    expect(store.actor).toEqual({ id: 'staff:uid-flor', source: 'admin_panel' });
    expect(store.dbSession?.context).toEqual({ kind: 'staff', uid: 'uid-flor', country: 'BR' });
  });

  it('[lex C3] staff Firebase SEM claim não ganha país nenhum (nunca AR)', async () => {
    const multiAuth = multiAuthDouble();
    multiAuth.tryAuthenticateAsApiKey = jest.fn().mockReturnValue(null);
    multiAuth.authenticateGoogleIdToken = jest.fn().mockResolvedValue({
      principal: { id: 'uid-sem-claim', type: PrincipalType.USER, roles: ['admin'] },
      credentials: { type: CredentialType.GOOGLE_ID_TOKEN, token: 't', scopes: [] },
      metadata: { ipAddress: '127.0.0.1', requestId: 'r3', timestamp: new Date(), path: '', method: '' },
    });
    const middleware = new AuthMiddleware(multiAuth, {} as never).requireStaffOrApiKey();
    const [req, res, next] = makeReqRes({ headers: { authorization: 'Bearer firebase-token' } });

    const store = await runWithSession(middleware, req, res, next);

    expect(store.dbSession?.context).toEqual({ kind: 'staff', uid: 'uid-sem-claim' });
    expect(store.dbSession?.context?.country).toBeUndefined();
  });

  it('principal Firebase SEM roles e request sem IP não quebram (401 limpo)', async () => {
    const multiAuth = multiAuthDouble();
    multiAuth.tryAuthenticateAsApiKey = jest.fn().mockReturnValue(null);
    multiAuth.authenticateGoogleIdToken = jest.fn().mockResolvedValue({
      principal: { id: 'uid-sem-roles', type: PrincipalType.USER },
      credentials: { type: CredentialType.GOOGLE_ID_TOKEN, token: 't', scopes: [] },
      metadata: { ipAddress: 'unknown', requestId: 'r4', timestamp: new Date(), path: '', method: '' },
    });
    const middleware = new AuthMiddleware(multiAuth, {} as never).requireStaffOrApiKey();
    const [req, res, next] = makeReqRes({
      headers: { authorization: 'Bearer firebase-token' },
      ip: undefined,
    } as unknown as Partial<Request>);

    const store = await runWithSession(middleware, req, res, next);

    // Sem papel de staff não passa — e o IP ausente vira 'unknown' no metadata.
    expect((res.status as jest.Mock).mock.calls[0][0]).toBe(401);
    expect(multiAuth.authenticateGoogleIdToken).toHaveBeenCalledWith(
      'firebase-token',
      expect.objectContaining({ ipAddress: 'unknown' }),
    );
    expect(store.dbSession?.context).toBeUndefined();
  });

  it('chave de API vira contexto de SISTEMA com o nome do serviço', async () => {
    const multiAuth = multiAuthDouble();
    multiAuth.tryAuthenticateAsApiKey = jest.fn().mockReturnValue(apiKeyContext);
    multiAuth.authenticateGoogleIdToken = jest.fn();
    const middleware = new AuthMiddleware(multiAuth, {} as never).requireStaffOrApiKey();
    const [req, res, next] = makeReqRes({ headers: { authorization: 'Bearer key123' } });

    const store = await runWithSession(middleware, req, res, next);

    expect(next).toHaveBeenCalled();
    expect(store.dbSession?.context).toEqual({
      kind: 'system',
      systemContext: 'api-key:service:triage',
    });
    // Serviço não é pessoa: nada de ator de staff na trilha.
    expect(store.actor).toBeUndefined();
  });

  it('MockAuth (e2e) também carimba ator e país do token mock', async () => {
    process.env.USE_MOCK_AUTH = 'true';
    const middleware = new AuthMiddleware(multiAuthDouble(), {} as never).requireStaffOrApiKey();
    const [req, res, next] = makeReqRes({
      user: { uid: 'u-e2e', email: 'e2e@enlite.health', role: 'admin', country: 'AR' },
    } as unknown as Partial<Request>);

    const store = await runWithSession(middleware, req, res, next);

    expect(next).toHaveBeenCalled();
    expect(store.actor).toEqual({ id: 'staff:u-e2e', source: 'admin_panel' });
    expect(store.dbSession?.context).toEqual({ kind: 'staff', uid: 'u-e2e', country: 'AR' });
  });

  it('MockAuth sem usuário ou sem papel de staff → 401 e nenhum contexto', async () => {
    process.env.USE_MOCK_AUTH = 'true';
    const middleware = new AuthMiddleware(multiAuthDouble(), {} as never).requireStaffOrApiKey();

    const [reqSemUser, resSemUser, nextSemUser] = makeReqRes();
    const semUser = await runWithSession(middleware, reqSemUser, resSemUser, nextSemUser);
    expect((resSemUser.status as jest.Mock).mock.calls[0][0]).toBe(401);
    expect(semUser.dbSession?.context).toBeUndefined();

    const [reqWorker, resWorker, nextWorker] = makeReqRes({
      user: { uid: 'w1', role: 'worker' },
    } as unknown as Partial<Request>);
    const worker = await runWithSession(middleware, reqWorker, resWorker, nextWorker);
    expect((resWorker.status as jest.Mock).mock.calls[0][0]).toBe(401);
    expect(worker.dbSession?.context).toBeUndefined();
    expect(nextWorker).not.toHaveBeenCalled();
  });
});

describe('severidade do staff sem claim acompanha o estrago', () => {
  const ORIGINAL_FLAG = process.env.COUNTRY_RLS_ENABLED;
  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env.COUNTRY_RLS_ENABLED;
    else process.env.COUNTRY_RLS_ENABLED = ORIGINAL_FLAG;
  });

  async function authenticateMockUser(user: Record<string, unknown>): Promise<LogContext> {
    process.env.USE_MOCK_AUTH = 'true';
    const middleware = new AuthMiddleware(multiAuthDouble(), {} as never).requireAuth();
    const [req, res, next] = makeReqRes({ user, ip: undefined } as unknown as Partial<Request>);
    return runWithSession(middleware, req, res, next);
  }

  it('flag ON: staff sem claim é ERRO (é gente sem enxergar nada agora)', async () => {
    process.env.COUNTRY_RLS_ENABLED = 'true';
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => undefined);

    const store = await authenticateMockUser({ uid: 'u-sem-claim', role: 'admin' });

    expect(errorSpy).toHaveBeenCalledWith(
      { uid: 'u-sem-claim', claimCountry: null },
      expect.stringContaining('sem claim de país'),
    );
    expect(store.dbSession?.context?.country).toBeUndefined();
    errorSpy.mockRestore();
  });

  it('flag OFF: o mesmo caso é só AVISO (ainda é um staff a instrumentar)', async () => {
    delete process.env.COUNTRY_RLS_ENABLED;
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => undefined);

    await authenticateMockUser({ uid: 'u-sem-claim-2', role: 'admin', country: 'zz' });

    expect(warnSpy).toHaveBeenCalledWith(
      { uid: 'u-sem-claim-2', claimCountry: 'zz' },
      expect.stringContaining('sem claim de país'),
    );
    expect(errorSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('usuário mock sem papel nenhum é worker_self (não staff por omissão)', async () => {
    const store = await authenticateMockUser({ uid: 'w-sem-role', email: 'p@x.com' });

    expect(store.dbSession?.context).toEqual({ kind: 'worker_self', uid: 'w-sem-role' });
    expect(store.actor).toEqual({ id: 'worker_self:w-sem-role', source: 'worker_self' });
  });
});

describe('requireApiKey — serviço é SISTEMA, nunca worker_self', () => {
  /** authService mínimo: parseCredentials + authenticate (sem Firebase real). */
  function authServiceDouble(principal: AuthContext['principal'] | null) {
    return {
      parseCredentials: jest.fn().mockReturnValue({
        type: CredentialType.API_KEY,
        token: 'key123',
        scopes: [],
      }),
      authenticate: jest
        .fn()
        .mockResolvedValue(principal ? { ...apiKeyContext, principal } : null),
    } as never;
  }

  it('sem header x-api-key → 401 antes de qualquer autenticação', async () => {
    const authService = authServiceDouble(apiKeyContext.principal);
    const middleware = new AuthMiddleware(authService, {} as never).requireApiKey();
    const [req, res, next] = makeReqRes();

    const store = await runWithSession(middleware, req, res, next);

    expect((res.status as jest.Mock).mock.calls[0][0]).toBe(401);
    expect(next).not.toHaveBeenCalled();
    expect(store.dbSession?.context).toBeUndefined();
  });

  it('serviço autenticado é classificado como sistema (e NÃO como worker_self)', async () => {
    const authService = authServiceDouble(apiKeyContext.principal);
    const middleware = new AuthMiddleware(authService, {} as never).requireApiKey();
    const [req, res, next] = makeReqRes({ headers: { 'x-api-key': 'key123' } });

    const store = await runWithSession(middleware, req, res, next);

    expect(next).toHaveBeenCalled();
    expect(store.dbSession?.context).toEqual({
      kind: 'system',
      systemContext: 'api-key:service:triage',
    });
  });

  it('credencial inválida → 401 e nenhuma classificação de sistema', async () => {
    const authService = authServiceDouble(null);
    const middleware = new AuthMiddleware(authService, {} as never).requireApiKey();
    const [req, res, next] = makeReqRes({ headers: { 'x-api-key': 'key123' } });

    const store = await runWithSession(middleware, req, res, next);

    expect((res.status as jest.Mock).mock.calls[0][0]).toBe(401);
    expect(store.dbSession?.context).toBeUndefined();
  });
});
