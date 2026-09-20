/**
 * AuthMiddleware — os dois métodos que faltavam sair do escuro:
 * `requirePermission` (delega ao motor de autorização) e `optionalAuth`
 * (autentica se der, nunca falha).
 *
 * Não são parte da mudança de ABAC, mas estavam sem teste no arquivo que a
 * mudança toca — e o gate do review pede o arquivo inteiro coberto. O que
 * importa aqui: negação é 403 COM o motivo do motor, falha do motor é 500 (nunca
 * "passa mesmo assim"), e `optionalAuth` engole erro de autenticação sem virar
 * 500 — é rota que funciona com e sem credencial.
 */

import type { Request, Response, NextFunction } from 'express';
import { AuthMiddleware } from '../AuthMiddleware';
import { CredentialType, PrincipalType, type AuthContext } from '../../../domain/Auth';

const authContext: AuthContext = {
  principal: { id: 'uid-1', type: PrincipalType.USER, roles: ['recruiter'] },
  credentials: { type: CredentialType.GOOGLE_ID_TOKEN, token: 't', scopes: [] },
  metadata: { ipAddress: '127.0.0.1', requestId: 'r', timestamp: new Date(), path: '', method: '' },
};

function makeReqRes(overrides: Partial<Request> = {}): [Request, Response, NextFunction] {
  const req = {
    headers: {},
    ip: '127.0.0.1',
    path: '/api/workers/w1',
    method: 'GET',
    params: { id: 'w1' },
    body: {},
    ...overrides,
  } as unknown as Request;
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return [req, res, jest.fn() as NextFunction];
}

describe('requirePermission', () => {
  it('sem authContext → 401 (o guard de auth roda antes, por contrato)', async () => {
    const middleware = new AuthMiddleware({} as never, {} as never).requirePermission('worker', 'read');
    const [req, res, next] = makeReqRes();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('permitido → segue e deixa a decisão na request (para auditoria)', async () => {
    const decision = { allowed: true, reason: 'role recruiter' };
    const engine = { checkPermission: jest.fn().mockResolvedValue(decision) };
    const middleware = new AuthMiddleware({} as never, engine as never).requirePermission('worker', 'read');
    const [req, res, next] = makeReqRes({ authContext } as unknown as Partial<Request>);

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect((req as Request & { accessDecision: unknown }).accessDecision).toBe(decision);
    expect(engine.checkPermission).toHaveBeenCalledWith(
      authContext,
      expect.objectContaining({ type: 'worker', id: 'w1' }),
      'read',
    );
  });

  it('negado → 403 com o motivo dado pelo motor', async () => {
    const engine = { checkPermission: jest.fn().mockResolvedValue({ allowed: false, reason: 'sem escopo' }) };
    const middleware = new AuthMiddleware({} as never, engine as never).requirePermission('worker', 'delete');
    const [req, res, next] = makeReqRes({ authContext } as unknown as Partial<Request>);

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect((res.json as jest.Mock).mock.calls[0][0].reason).toBe('sem escopo');
    expect(next).not.toHaveBeenCalled();
  });

  it('motor fora do ar → 500, NUNCA "passa mesmo assim"', async () => {
    const engine = { checkPermission: jest.fn().mockRejectedValue(new Error('cerbos fora')) };
    const middleware = new AuthMiddleware({} as never, engine as never).requirePermission('worker', 'read');
    const [req, res, next] = makeReqRes({ authContext } as unknown as Partial<Request>);
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(next).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('optionalAuth', () => {
  it('sem credencial: segue anônimo', async () => {
    const authService = { parseCredentials: jest.fn().mockReturnValue(null), authenticate: jest.fn() };
    const middleware = new AuthMiddleware(authService as never, {} as never).optionalAuth();
    const [req, res, next] = makeReqRes();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(authService.authenticate).not.toHaveBeenCalled();
    expect((req as Request & { authContext?: unknown }).authContext).toBeUndefined();
  });

  it('com credencial válida: anexa o contexto e segue', async () => {
    const authService = {
      parseCredentials: jest.fn().mockReturnValue(authContext.credentials),
      authenticate: jest.fn().mockResolvedValue(authContext),
    };
    const middleware = new AuthMiddleware(authService as never, {} as never).optionalAuth();
    const [req, res, next] = makeReqRes();

    await middleware(req, res, next);

    expect((req as Request & { authContext: AuthContext }).authContext).toBe(authContext);
    expect(next).toHaveBeenCalled();
  });

  it('credencial inválida não vira erro: segue anônimo', async () => {
    const authService = {
      parseCredentials: jest.fn().mockReturnValue(authContext.credentials),
      authenticate: jest.fn().mockResolvedValue(null),
    };
    const middleware = new AuthMiddleware(authService as never, {} as never).optionalAuth();
    const [req, res, next] = makeReqRes();

    await middleware(req, res, next);

    expect((req as Request & { authContext?: unknown }).authContext).toBeUndefined();
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('erro na autenticação opcional NÃO derruba a rota', async () => {
    const authService = {
      parseCredentials: jest.fn().mockImplementation(() => {
        throw new Error('parser explodiu');
      }),
      authenticate: jest.fn(),
    };
    const middleware = new AuthMiddleware(authService as never, {} as never).optionalAuth();
    const [req, res, next] = makeReqRes();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('requireStaff', () => {
  /** authService que autentica com os papéis dados. */
  function authServiceWithRoles(roles: string[]) {
    return {
      parseCredentials: jest.fn().mockReturnValue(authContext.credentials),
      authenticate: jest.fn().mockResolvedValue({
        ...authContext,
        principal: { ...authContext.principal, roles },
      }),
    } as never;
  }

  it.each([['admin'], ['recruiter'], ['community_manager']])('papel %s passa', async (role) => {
    const middleware = new AuthMiddleware(authServiceWithRoles([role]), {} as never).requireStaff();
    const [req, res, next] = makeReqRes();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('prestador autenticado NÃO é staff → 403 (não 401: ele tem credencial)', async () => {
    const middleware = new AuthMiddleware(authServiceWithRoles(['worker']), {} as never).requireStaff();
    const [req, res, next] = makeReqRes();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect((res.json as jest.Mock).mock.calls[0][0].error).toBe('Staff access required');
    expect(next).not.toHaveBeenCalled();
  });

  // D294 — a fronteira é o TIPO da conta; o papel é só a ponte.
  function authServiceWith(principal: Partial<AuthContext['principal']>) {
    return {
      parseCredentials: jest.fn().mockReturnValue(authContext.credentials),
      authenticate: jest.fn().mockResolvedValue({
        ...authContext,
        principal: { id: 'uid-1', type: PrincipalType.USER, ...principal },
      }),
    } as never;
  }

  it('account_type=staff passa MESMO sem papel nenhum (o claim novo basta)', async () => {
    const middleware = new AuthMiddleware(authServiceWith({ accountType: 'staff', roles: [] }), {} as never).requireStaff();
    const [req, res, next] = makeReqRes();
    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect((req as Request & { user: { accountType?: string } }).user.accountType).toBe('staff');
  });

  it('account_type=worker é barrado MESMO com papel admin — o tipo declarado vence a ponte', async () => {
    const middleware = new AuthMiddleware(authServiceWith({ accountType: 'worker', roles: ['admin'] }), {} as never).requireStaff();
    const [req, res, next] = makeReqRes();
    await middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('sem tipo e sem papel → 403 (lex C5: a ponte nunca concede por ausência)', async () => {
    const middleware = new AuthMiddleware(authServiceWith({ roles: [] }), {} as never).requireStaff();
    const [req, res, next] = makeReqRes();
    await middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('autenticação que EXPLODE → 500 sem vazar o erro (o catch do requireAuth)', async () => {
    const authService = {
      parseCredentials: jest.fn().mockReturnValue(authContext.credentials),
      authenticate: jest.fn().mockRejectedValue(new Error('idp fora')),
    };
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const middleware = new AuthMiddleware(authService as never, {} as never).requireStaff();
    const [req, res, next] = makeReqRes();
    await middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(500);
    expect((res.json as jest.Mock).mock.calls[0][0]).toEqual({ success: false, error: 'Authentication error' });
    expect(next).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('sem credencial nenhuma → 401 do requireAuth, sem chegar ao check de papel', async () => {
    const authService = { parseCredentials: jest.fn().mockReturnValue(null), authenticate: jest.fn() };
    const middleware = new AuthMiddleware(authService as never, {} as never).requireStaff();
    const [req, res, next] = makeReqRes();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('acessores estáticos', () => {
  it('devolvem o que os middlewares deixaram na request', () => {
    const decision = { allowed: true };
    const req = { authContext, accessDecision: decision } as unknown as Request;

    expect(AuthMiddleware.getAuthContext(req)).toBe(authContext);
    expect(AuthMiddleware.getAccessDecision(req)).toBe(decision);
    expect(AuthMiddleware.getAuthContext({} as Request)).toBeUndefined();
  });
});
