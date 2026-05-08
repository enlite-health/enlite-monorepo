/**
 * ClickUpHmacMiddleware — Unit Tests
 *
 * Cenários cobertos:
 *
 * 1. Sem header X-Signature → 401
 * 2. Sem rawBody no request → 500 (defensive, rawBody capture falhou)
 * 3. Assinatura válida + secret correto → next() chamado
 * 4. Assinatura inválida (conteúdo errado) → 401
 * 5. Assinatura de length diferente → 401 (sem crash por timingSafeEqual)
 * 6. Constructor sem secret → lança exceção
 * 7. Constructor com secret vazio → lança exceção
 */

const mockLoggerWarn  = jest.fn();
const mockLoggerError = jest.fn();

jest.mock('firebase-functions', () => ({
  logger: {
    info:  jest.fn(),
    warn:  (...args: unknown[]) => mockLoggerWarn(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}));

import * as crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { ClickUpHmacMiddleware } from '../ClickUpHmacMiddleware';

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

const SECRET   = 'test-secret-abc123';
const RAW_BODY = '{"event":"taskCreated","webhook_id":"wh-1","task_id":"t-1"}';

function makeSignature(body: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function makeMockReq(overrides: { signature?: string; rawBody?: string } = {}): Partial<Request> {
  const req: Record<string, unknown> = {
    url:    '/api/webhooks/clickup/patient',
    header: (name: string) => {
      if (name === 'X-Signature') return overrides.signature;
      return undefined;
    },
  };
  if (overrides.rawBody !== undefined) {
    req['rawBody'] = overrides.rawBody;
  }
  return req as unknown as Partial<Request>;
}

function makeMockRes(): { res: Partial<Response>; statusCode: () => number | null; body: () => unknown } {
  let code: number | null = null;
  let responseBody: unknown = null;
  const res: Partial<Response> = {
    status: jest.fn().mockImplementation((c: number) => { code = c; return res; }),
    json:   jest.fn().mockImplementation((b: unknown) => { responseBody = b; return res; }),
  };
  return { res, statusCode: () => code, body: () => responseBody };
}

// ─────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────

describe('ClickUpHmacMiddleware', () => {
  let next: jest.MockedFunction<NextFunction>;

  beforeEach(() => {
    jest.clearAllMocks();
    next = jest.fn();
  });

  // ─────────────────────────────────────────────────────────────────
  // Constructor validation
  // ─────────────────────────────────────────────────────────────────

  describe('constructor', () => {
    it('deve lançar exceção quando secret é string vazia', () => {
      expect(() => new ClickUpHmacMiddleware('')).toThrow('non-empty secret');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 1. Missing X-Signature header
  // ─────────────────────────────────────────────────────────────────

  it('deve retornar 401 quando X-Signature está ausente', () => {
    const mw = new ClickUpHmacMiddleware(SECRET);
    const req = makeMockReq({ rawBody: RAW_BODY });
    const { res, statusCode, body } = makeMockRes();

    mw.verify()(req as Request, res as Response, next);

    expect(statusCode()).toBe(401);
    expect((body() as Record<string, unknown>).error).toBe('X-Signature header missing');
    expect(next).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith('clickup_webhook.hmac_missing', expect.any(Object));
  });

  // ─────────────────────────────────────────────────────────────────
  // 2. Missing rawBody (defensive)
  // ─────────────────────────────────────────────────────────────────

  it('deve retornar 500 quando rawBody não foi capturado', () => {
    const mw  = new ClickUpHmacMiddleware(SECRET);
    const sig = makeSignature(RAW_BODY, SECRET);
    // rawBody omitted → undefined
    const req = makeMockReq({ signature: sig });
    const { res, statusCode, body } = makeMockRes();

    mw.verify()(req as Request, res as Response, next);

    expect(statusCode()).toBe(500);
    expect((body() as Record<string, unknown>).error).toBe('raw body capture failed');
    expect(next).not.toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalledWith('clickup_webhook.raw_body_missing', expect.any(Object));
  });

  // ─────────────────────────────────────────────────────────────────
  // 3. Valid signature → next()
  // ─────────────────────────────────────────────────────────────────

  it('deve chamar next() quando assinatura é válida', () => {
    const mw  = new ClickUpHmacMiddleware(SECRET);
    const sig = makeSignature(RAW_BODY, SECRET);
    const req = makeMockReq({ signature: sig, rawBody: RAW_BODY });
    const { res, statusCode } = makeMockRes();

    mw.verify()(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
    expect(statusCode()).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────
  // 4. Invalid signature (same length, wrong content)
  // ─────────────────────────────────────────────────────────────────

  it('deve retornar 401 quando assinatura tem conteúdo errado (mesmo tamanho)', () => {
    const mw  = new ClickUpHmacMiddleware(SECRET);
    // Produce a same-length signature using a different secret
    const badSig = makeSignature(RAW_BODY, 'wrong-secret');
    const req = makeMockReq({ signature: badSig, rawBody: RAW_BODY });
    const { res, statusCode, body } = makeMockRes();

    mw.verify()(req as Request, res as Response, next);

    expect(statusCode()).toBe(401);
    expect((body() as Record<string, unknown>).error).toBe('invalid signature');
    expect(next).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith('clickup_webhook.hmac_invalid', expect.any(Object));
  });

  // ─────────────────────────────────────────────────────────────────
  // 5. Different-length signature (must not crash timingSafeEqual)
  // ─────────────────────────────────────────────────────────────────

  it('deve retornar 401 sem crash quando signature tem tamanho diferente', () => {
    const mw  = new ClickUpHmacMiddleware(SECRET);
    const req = makeMockReq({ signature: 'tooshort', rawBody: RAW_BODY });
    const { res, statusCode } = makeMockRes();

    expect(() => mw.verify()(req as Request, res as Response, next)).not.toThrow();
    expect(statusCode()).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────────
  // 6. verify() is a factory — each call returns a new function
  // ─────────────────────────────────────────────────────────────────

  it('verify() deve retornar uma nova função a cada chamada', () => {
    const mw = new ClickUpHmacMiddleware(SECRET);
    const fn1 = mw.verify();
    const fn2 = mw.verify();
    expect(fn1).not.toBe(fn2);
  });

  // ─────────────────────────────────────────────────────────────────
  // 7. Empty rawBody string (not undefined — capture worked but body was empty)
  // ─────────────────────────────────────────────────────────────────

  it('deve validar assinatura corretamente quando rawBody é string vazia', () => {
    const mw     = new ClickUpHmacMiddleware(SECRET);
    const emptySig = makeSignature('', SECRET);
    const req = makeMockReq({ signature: emptySig, rawBody: '' });
    const { res } = makeMockRes();

    mw.verify()(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
  });
});
