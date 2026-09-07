/**
 * AuthMiddleware.requireStaffOrApiKey.test.ts
 *
 * Testa o middleware híbrido: API key OU staff Firebase.
 */
import { Request, Response, NextFunction } from 'express';
import { AuthMiddleware } from '../AuthMiddleware';
import { MultiAuthService } from '../../../infrastructure/MultiAuthService';
import { SimplifiedAuthorizationEngine } from '../../../infrastructure/SimplifiedAuthorizationEngine';
import { PrincipalType, CredentialType } from '../../../domain/Auth';

jest.mock('../../../infrastructure/MultiAuthService');
jest.mock('../../../infrastructure/SimplifiedAuthorizationEngine');
jest.mock('@shared/logging', () => ({
  logger: { child: jest.fn().mockReturnValue({ info: jest.fn(), error: jest.fn() }) },
  reportError: jest.fn(),
}));

function makeReqRes(token?: string): [Request, Response, NextFunction] {
  const req = {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ip: '127.0.0.1',
    path: '/test',
    method: 'GET',
  } as unknown as Request;
  const res = {
    status: jest.fn().mockReturnThis(),
    end: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
  const next = jest.fn() as NextFunction;
  return [req, res, next];
}

describe('AuthMiddleware.requireStaffOrApiKey', () => {
  let authMiddleware: AuthMiddleware;
  let mockMultiAuth: jest.Mocked<MultiAuthService>;
  let mockAuthzEngine: jest.Mocked<SimplifiedAuthorizationEngine>;

  const validApiKeyContext = {
    principal: { id: 'service:triage', type: PrincipalType.SERVICE, roles: [] },
    credentials: { type: CredentialType.API_KEY, token: 'key123', scopes: [] },
    metadata: { ipAddress: '127.0.0.1', requestId: 'r1', timestamp: new Date(), path: '', method: '' },
  };

  const staffFirebaseContext = {
    principal: { id: 'user-uid', type: PrincipalType.USER, roles: ['admin'] },
    credentials: { type: CredentialType.GOOGLE_ID_TOKEN, token: 'firebase-token', scopes: [] },
    metadata: { ipAddress: '127.0.0.1', requestId: 'r2', timestamp: new Date(), path: '', method: '' },
  };

  beforeEach(() => {
    mockMultiAuth = new (MultiAuthService as any)() as jest.Mocked<MultiAuthService>;
    mockAuthzEngine = new SimplifiedAuthorizationEngine() as jest.Mocked<SimplifiedAuthorizationEngine>;

    // Para que instanceof MultiAuthService funcione, precisamos que o mock preserve o prototype
    Object.setPrototypeOf(mockMultiAuth, MultiAuthService.prototype);

    authMiddleware = new AuthMiddleware(mockMultiAuth, mockAuthzEngine);
  });

  it('retorna 401 quando Authorization header está ausente', async () => {
    const [req, res, next] = makeReqRes();
    await authMiddleware.requireStaffOrApiKey()(req, res, next);

    expect((res.status as jest.Mock).mock.calls[0][0]).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('autentica via API key sem chamar Firebase', async () => {
    mockMultiAuth.tryAuthenticateAsApiKey = jest.fn().mockReturnValue(validApiKeyContext);
    mockMultiAuth.authenticateGoogleIdToken = jest.fn();

    const [req, res, next] = makeReqRes('key123');
    await authMiddleware.requireStaffOrApiKey()(req, res, next);

    expect(mockMultiAuth.tryAuthenticateAsApiKey).toHaveBeenCalledWith('key123');
    expect(mockMultiAuth.authenticateGoogleIdToken).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('cai para Firebase quando API key não é válida', async () => {
    mockMultiAuth.tryAuthenticateAsApiKey = jest.fn().mockReturnValue(null);
    mockMultiAuth.authenticateGoogleIdToken = jest.fn().mockResolvedValue(staffFirebaseContext);

    const [req, res, next] = makeReqRes('firebase-token');
    await authMiddleware.requireStaffOrApiKey()(req, res, next);

    expect(mockMultiAuth.authenticateGoogleIdToken).toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('retorna 401 quando Firebase retorna user sem role staff', async () => {
    const nonStaffContext = {
      ...staffFirebaseContext,
      principal: { id: 'uid', type: PrincipalType.USER, roles: ['worker'] },
    };
    mockMultiAuth.tryAuthenticateAsApiKey = jest.fn().mockReturnValue(null);
    mockMultiAuth.authenticateGoogleIdToken = jest.fn().mockResolvedValue(nonStaffContext);

    const [req, res, next] = makeReqRes('firebase-token');
    await authMiddleware.requireStaffOrApiKey()(req, res, next);

    expect((res.status as jest.Mock).mock.calls[0][0]).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('D294: Firebase com account_type=staff e SEM papel passa; account_type=worker com papel admin não', async () => {
    mockMultiAuth.tryAuthenticateAsApiKey = jest.fn().mockReturnValue(null);
    mockMultiAuth.authenticateGoogleIdToken = jest.fn().mockResolvedValue({
      ...staffFirebaseContext,
      principal: { id: 'uid', type: PrincipalType.USER, roles: [], accountType: 'staff' },
    });
    const [req, res, next] = makeReqRes('firebase-token');
    await authMiddleware.requireStaffOrApiKey()(req, res, next);
    expect(next).toHaveBeenCalled();
    expect((req as unknown as { user: { accountType?: string } }).user.accountType).toBe('staff');

    mockMultiAuth.authenticateGoogleIdToken = jest.fn().mockResolvedValue({
      ...staffFirebaseContext,
      principal: { id: 'uid', type: PrincipalType.USER, roles: ['admin'], accountType: 'worker' },
    });
    const [req2, res2, next2] = makeReqRes('firebase-token');
    await authMiddleware.requireStaffOrApiKey()(req2, res2, next2);
    expect((res2.status as jest.Mock).mock.calls[0][0]).toBe(401);
    expect(next2).not.toHaveBeenCalled();
  });

  it('D294 (mock auth): account_type no token mock decide; sem ele, a ponte por role', async () => {
    process.env.USE_MOCK_AUTH = 'true';
    try {
      const [req, res, next] = makeReqRes('x');
      (req as unknown as { user: unknown }).user = { uid: 'u', role: 'admin', account_type: 'worker' };
      await authMiddleware.requireStaffOrApiKey()(req, res, next);
      expect((res.status as jest.Mock).mock.calls[0][0]).toBe(401);

      const [req2, res2, next2] = makeReqRes('x');
      (req2 as unknown as { user: unknown }).user = { uid: 'u', role: 'recruiter' };
      await authMiddleware.requireStaffOrApiKey()(req2, res2, next2);
      expect(next2).toHaveBeenCalled();
      expect(res2.status).not.toHaveBeenCalled();

      // sem tipo e sem papel → 401 (lex C5)
      const [req3, res3, next3] = makeReqRes('x');
      (req3 as unknown as { user: unknown }).user = { uid: 'u' };
      await authMiddleware.requireStaffOrApiKey()(req3, res3, next3);
      expect((res3.status as jest.Mock).mock.calls[0][0]).toBe(401);
      expect(next3).not.toHaveBeenCalled();
    } finally {
      delete process.env.USE_MOCK_AUTH;
    }
  });

  it('retorna 401 quando ambos falham', async () => {
    mockMultiAuth.tryAuthenticateAsApiKey = jest.fn().mockReturnValue(null);
    mockMultiAuth.authenticateGoogleIdToken = jest.fn().mockResolvedValue(null);

    const [req, res, next] = makeReqRes('invalid-token');
    await authMiddleware.requireStaffOrApiKey()(req, res, next);

    expect((res.status as jest.Mock).mock.calls[0][0]).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('retorna 401 quando Firebase lança exceção', async () => {
    mockMultiAuth.tryAuthenticateAsApiKey = jest.fn().mockReturnValue(null);
    mockMultiAuth.authenticateGoogleIdToken = jest.fn().mockRejectedValue(new Error('Firebase down'));

    const [req, res, next] = makeReqRes('bad-token');
    await authMiddleware.requireStaffOrApiKey()(req, res, next);

    expect((res.status as jest.Mock).mock.calls[0][0]).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});
