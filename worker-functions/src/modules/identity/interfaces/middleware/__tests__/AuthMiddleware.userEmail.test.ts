/**
 * AuthMiddleware.userEmail.test.ts
 *
 * `GET /api/admin/me/tactiq-link` respondia 400 NO_EMAIL para TODO mundo em produção: o
 * caminho REAL montava `req.user` sem `email` (só o mock o preenchia, por isso o e2e passava).
 * Estes testes travam os DOIS pontos reais — `requireAuth` e `requireStaffOrApiKey` — SEM
 * `USE_MOCK_AUTH`: o e-mail vem do principal (claim do token verificado), em minúsculas,
 * e sem e-mail no token a chave não existe (a rota segue respondendo 400 NO_EMAIL).
 * Fixtures sintéticas (@example.test).
 */
import type { Request, Response, NextFunction } from 'express';
import { AuthMiddleware } from '../AuthMiddleware';
import { MultiAuthService } from '../../../infrastructure/MultiAuthService';
import { PrincipalType, CredentialType, type AuthContext } from '../../../domain/Auth';

jest.mock('../../../infrastructure/MultiAuthService');

const MOCK_ANTES = process.env.USE_MOCK_AUTH;
beforeAll(() => {
  delete process.env.USE_MOCK_AUTH;
});
afterAll(() => {
  if (MOCK_ANTES === undefined) delete process.env.USE_MOCK_AUTH;
  else process.env.USE_MOCK_AUTH = MOCK_ANTES;
});

function contexto(email?: string): AuthContext {
  return {
    principal: { id: 'uid-staff', type: PrincipalType.USER, roles: ['admin'], accountType: 'staff', ...(email ? { email } : {}) },
    credentials: { type: CredentialType.GOOGLE_ID_TOKEN, token: 'tok', scopes: [] },
    metadata: { ipAddress: '127.0.0.1', requestId: 'r', timestamp: new Date(), path: '', method: '' },
  };
}

function reqRes(): [Request, Response, NextFunction] {
  const req = { headers: { authorization: 'Bearer tok' }, ip: '127.0.0.1', path: '/api/admin/me/tactiq-link', method: 'GET' } as unknown as Request;
  const res = { status: jest.fn().mockReturnThis(), end: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as unknown as Response;
  return [req, res, jest.fn() as NextFunction];
}

describe('requireAuth (caminho real) — e-mail em req.user', () => {
  function middleware(ctx: AuthContext): ReturnType<AuthMiddleware['requireAuth']> {
    const authService = {
      parseCredentials: jest.fn().mockReturnValue({ type: CredentialType.GOOGLE_ID_TOKEN, token: 'tok', scopes: [] }),
      authenticate: jest.fn().mockResolvedValue(ctx),
    };
    return new AuthMiddleware(authService as never, {} as never).requireAuth();
  }

  it('token com e-mail → req.user.email preenchido, em minúsculas', async () => {
    const [req, res, next] = reqRes();
    await middleware(contexto('Operador.Staff@Example.TEST'))(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.user?.email).toBe('operador.staff@example.test');
  });

  it('token sem e-mail → req.user.email ausente (a rota segue 400 NO_EMAIL)', async () => {
    const [req, res, next] = reqRes();
    await middleware(contexto())(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.user).toBeDefined();
    expect(req.user).not.toHaveProperty('email');
  });
});

describe('requireStaffOrApiKey (caminho real, Firebase) — e-mail em req.user', () => {
  function middleware(ctx: AuthContext): ReturnType<AuthMiddleware['requireStaffOrApiKey']> {
    const multi = new (MultiAuthService as never as new () => MultiAuthService)();
    Object.setPrototypeOf(multi, MultiAuthService.prototype);
    multi.tryAuthenticateAsApiKey = jest.fn().mockReturnValue(null);
    multi.authenticateGoogleIdToken = jest.fn().mockResolvedValue(ctx);
    return new AuthMiddleware(multi, {} as never).requireStaffOrApiKey();
  }

  it('token com e-mail → req.user.email preenchido, em minúsculas', async () => {
    const [req, res, next] = reqRes();
    await middleware(contexto('Operador.Staff@Example.TEST'))(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.user?.email).toBe('operador.staff@example.test');
  });

  it('token sem e-mail → req.user.email ausente', async () => {
    const [req, res, next] = reqRes();
    await middleware(contexto())(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.user).toBeDefined();
    expect(req.user).not.toHaveProperty('email');
  });
});
