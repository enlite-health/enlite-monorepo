/**
 * MockAuthMiddleware — a porta de entrada do e2e.
 *
 * O que estes testes travam:
 *  - o token mock carrega `country`, e ele chega a `req.user` VERBATIM: é assim
 *    que o e2e consegue exercitar a RLS de país com dois operadores de
 *    jurisdições diferentes. Ausente segue ausente (fail-closed, sem default);
 *  - fora de `USE_MOCK_AUTH=true` o middleware é inerte — ele não pode virar um
 *    bypass de autenticação se a env vazar para outro ambiente;
 *  - em modo mock, só token `mock_*` passa (nada de token real ser aceito por
 *    acidente).
 */

import type { Request, Response, NextFunction } from 'express';
import { mockAuthMiddleware, createMockAuthEndpoints } from '../MockAuthMiddleware';

const ORIGINAL_MOCK_AUTH = process.env.USE_MOCK_AUTH;

afterEach(() => {
  if (ORIGINAL_MOCK_AUTH === undefined) delete process.env.USE_MOCK_AUTH;
  else process.env.USE_MOCK_AUTH = ORIGINAL_MOCK_AUTH;
});

function mockToken(payload: Record<string, unknown>): string {
  return `mock_${Buffer.from(JSON.stringify(payload)).toString('base64')}`;
}

function makeReqRes(path: string, token?: string): [Request, Response, NextFunction] {
  const req = { path, headers: token ? { authorization: `Bearer ${token}` } : {} } as unknown as Request;
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as unknown as Response;
  return [req, res, jest.fn() as NextFunction];
}

describe('mockAuthMiddleware', () => {
  beforeEach(() => {
    process.env.USE_MOCK_AUTH = 'true';
  });

  it('propaga o país do token mock para req.user (é o que o e2e da RLS usa)', () => {
    const [req, , next] = makeReqRes('/api/admin/patients', mockToken({ uid: 'u1', email: 'a@b.c', role: 'admin', country: 'BR' }));

    mockAuthMiddleware(req, {} as Response, next);

    expect(next).toHaveBeenCalled();
    expect((req as Request & { user: Record<string, unknown> }).user).toEqual({
      uid: 'u1',
      email: 'a@b.c',
      role: 'admin',
      account_type: null,
      country: 'BR',
    });
  });

  it('token mock com account_type o propaga; sem ele fica null (a ponte por role decide depois — D294)', () => {
    const [req, , next] = makeReqRes('/api/admin/patients', mockToken({ uid: 'u3', email: 'a@b.c', role: 'admin', account_type: 'worker' }));
    mockAuthMiddleware(req, {} as Response, next);
    expect((req as Request & { user: Record<string, unknown> }).user).toMatchObject({ account_type: 'worker' });
  });

  it('token sem country deixa o campo AUSENTE (nunca um default)', () => {
    const [req, , next] = makeReqRes('/api/admin/patients', mockToken({ uid: 'u2', email: 'a@b.c', role: 'recruiter' }));

    mockAuthMiddleware(req, {} as Response, next);

    const user = (req as Request & { user: Record<string, unknown> }).user;
    expect(user.country).toBeUndefined();
    expect(user.role).toBe('recruiter');
  });

  it('sem role explícito o usuário é worker', () => {
    const [req, , next] = makeReqRes('/api/admin/patients', mockToken({ uid: 'u3', email: 'a@b.c' }));

    mockAuthMiddleware(req, {} as Response, next);

    expect((req as Request & { user: { role: string } }).user.role).toBe('worker');
  });

  it('fora de USE_MOCK_AUTH=true é inerte (não vira bypass de autenticação)', () => {
    delete process.env.USE_MOCK_AUTH;
    const [req, res, next] = makeReqRes('/api/admin/patients');

    mockAuthMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect((req as Request & { user?: unknown }).user).toBeUndefined();
  });

  it('rotas públicas passam sem token', () => {
    for (const path of ['/health', '/api/webhooks/twilio', '/api/internal/outbox', '/api/admin/setup']) {
      const [req, res, next] = makeReqRes(path);
      mockAuthMiddleware(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    }
  });

  it('sem Authorization → 401', () => {
    const [req, res, next] = makeReqRes('/api/admin/patients');
    mockAuthMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('token que não é mock_* → 401 (nada de token real passar por acidente)', () => {
    const [req, res, next] = makeReqRes('/api/admin/patients', 'eyJhbGciOi.real.token');
    mockAuthMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('token mock sem uid/email → 401', () => {
    const [req, res, next] = makeReqRes('/api/admin/patients', mockToken({ role: 'admin' }));
    mockAuthMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect((res.json as jest.Mock).mock.calls[0][0].error).toMatch(/uid and email/);
  });

  it('token mock corrompido → 401 com erro de formato', () => {
    const [req, res, next] = makeReqRes('/api/admin/patients', 'mock_@@@nao-e-base64-json@@@');
    mockAuthMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect((res.json as jest.Mock).mock.calls[0][0].error).toMatch(/format/);
  });
});

describe('createMockAuthEndpoints', () => {
  function fakeApp() {
    const routes = new Map<string, (req: Request, res: Response) => void>();
    return {
      routes,
      post: jest.fn((path: string, handler: (req: Request, res: Response) => void) => routes.set(`POST ${path}`, handler)),
      get: jest.fn((path: string, _mw: unknown, handler: (req: Request, res: Response) => void) =>
        routes.set(`GET ${path}`, handler),
      ),
    };
  }

  it('não registra nada fora do modo mock', () => {
    delete process.env.USE_MOCK_AUTH;
    const app = fakeApp();
    createMockAuthEndpoints(app);
    expect(app.post).not.toHaveBeenCalled();
    expect(app.get).not.toHaveBeenCalled();
  });

  it('emite token mock utilizável e verifica o usuário', () => {
    process.env.USE_MOCK_AUTH = 'true';
    const app = fakeApp();
    createMockAuthEndpoints(app);

    const issue = app.routes.get('POST /api/test/auth/token')!;
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as unknown as Response;
    issue({ body: { uid: 'u9', email: 'e@x.com', role: 'admin' } } as Request, res);

    const token = (res.json as jest.Mock).mock.calls[0][0].data.token as string;
    expect(token.startsWith('mock_')).toBe(true);

    // O token emitido passa pelo próprio middleware.
    const [req, , next] = makeReqRes('/api/admin/patients', token);
    process.env.USE_MOCK_AUTH = 'true';
    mockAuthMiddleware(req, {} as Response, next);
    expect((req as Request & { user: { uid: string } }).user.uid).toBe('u9');
  });

  it('emissão sem role gera token de worker (default explícito)', () => {
    process.env.USE_MOCK_AUTH = 'true';
    const app = fakeApp();
    createMockAuthEndpoints(app);

    const issue = app.routes.get('POST /api/test/auth/token')!;
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as unknown as Response;
    issue({ body: { uid: 'u10', email: 'e@x.com' } } as Request, res);

    const token = (res.json as jest.Mock).mock.calls[0][0].data.token as string;
    const payload = JSON.parse(Buffer.from(token.replace('mock_', ''), 'base64').toString());
    expect(payload.role).toBe('worker');
  });

  it('emissão sem uid/email → 400', () => {
    process.env.USE_MOCK_AUTH = 'true';
    const app = fakeApp();
    createMockAuthEndpoints(app);

    const issue = app.routes.get('POST /api/test/auth/token')!;
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as unknown as Response;
    issue({ body: {} } as Request, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('/verify responde o usuário autenticado, e 401 sem ele', () => {
    process.env.USE_MOCK_AUTH = 'true';
    const app = fakeApp();
    createMockAuthEndpoints(app);
    const verify = app.routes.get('GET /api/test/auth/verify')!;

    const okRes = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as unknown as Response;
    verify({ user: { uid: 'u1', country: 'AR' } } as unknown as Request, okRes);
    expect((okRes.json as jest.Mock).mock.calls[0][0].data).toEqual({ uid: 'u1', country: 'AR' });

    const koRes = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as unknown as Response;
    verify({} as Request, koRes);
    expect(koRes.status).toHaveBeenCalledWith(401);
  });
});
