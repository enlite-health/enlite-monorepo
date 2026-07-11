/**
 * AuthTelemetryController — sink de telemetria do login admin.
 *
 * Cobre:
 *   1. payload válido (success) → 204 + logger.info com o registro estruturado
 *   2. payload válido (denied/error) → 204 + logger.warn
 *   3. payload inválido (traceId ausente, flow errado, steps > 50) → 400, sem log
 *   4. verifiedUid extraído de req.user.uid (token via requireAuth)
 *   5. verifiedUid extraído de req.authContext.userId (token via optionalAuth), sem req.user
 */

const childLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('@shared/logging', () => ({
  logger: { child: jest.fn().mockReturnValue(childLogger) },
  reportError: jest.fn(),
}));

import { Request, Response } from 'express';
import { AuthTelemetryController } from '../AuthTelemetryController';

function mockRes(): Response & { _status: number; _json: unknown; _ended: boolean } {
  const res = {
    _status: 0,
    _json: undefined as unknown,
    _ended: false,
    status(code: number) { this._status = code; return this; },
    json(body: unknown) { this._json = body; return this; },
    end() { this._ended = true; return this; },
  };
  return res as unknown as Response & { _status: number; _json: unknown; _ended: boolean };
}

function mockReq(body: unknown, extra: Partial<Request> = {}): Request {
  return { body, headers: { 'user-agent': 'jest' }, ip: '1.2.3.4', ...extra } as unknown as Request;
}

const validPayload = {
  traceId: 'login-abc-1',
  flow: 'google' as const,
  outcome: 'success' as const,
  durationMs: 1234,
  steps: [
    { step: 'start', elapsedMs: 0, level: 'info' as const },
    { step: 'backend-profile:ok', elapsedMs: 900, level: 'info' as const, data: { role: 'admin' } },
  ],
};

describe('AuthTelemetryController', () => {
  let controller: AuthTelemetryController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new AuthTelemetryController();
  });

  it('payload válido (success) → 204 e logger.info com o registro estruturado', () => {
    const res = mockRes();
    controller.logTrace(mockReq(validPayload), res);

    expect(res._status).toBe(204);
    expect(res._ended).toBe(true);
    expect(childLogger.info).toHaveBeenCalledTimes(1);
    expect(childLogger.warn).not.toHaveBeenCalled();
    expect(childLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: 'login-abc-1',
        flow: 'google',
        outcome: 'success',
        durationMs: 1234,
        steps: validPayload.steps,
      }),
    );
  });

  it('outcome denied/error → logger.warn (falha de login não é fault do servidor)', () => {
    const res = mockRes();
    controller.logTrace(mockReq({ ...validPayload, outcome: 'denied' }), res);

    expect(res._status).toBe(204);
    expect(childLogger.warn).toHaveBeenCalledTimes(1);
    expect(childLogger.info).not.toHaveBeenCalled();
  });

  it('payload inválido → 400 e nenhum log', () => {
    for (const bad of [
      { ...validPayload, traceId: undefined },
      { ...validPayload, flow: 'saml' },
      { ...validPayload, steps: Array.from({ length: 51 }, () => ({ step: 's', elapsedMs: 1, level: 'info' })) },
      'not-an-object',
    ]) {
      jest.clearAllMocks();
      const res = mockRes();
      controller.logTrace(mockReq(bad), res);
      expect(res._status).toBe(400);
      expect(childLogger.info).not.toHaveBeenCalled();
      expect(childLogger.warn).not.toHaveBeenCalled();
    }
  });

  it('verifiedUid vem de req.user.uid quando presente', () => {
    const res = mockRes();
    controller.logTrace(mockReq(validPayload, { user: { uid: 'uid-req-user' } } as unknown as Partial<Request>), res);
    expect(childLogger.info).toHaveBeenCalledWith(expect.objectContaining({ verifiedUid: 'uid-req-user' }));
  });

  it('verifiedUid vem de req.authContext.userId (optionalAuth) quando não há req.user', () => {
    const res = mockRes();
    controller.logTrace(
      mockReq(validPayload, { authContext: { userId: 'uid-ctx' } } as unknown as Partial<Request>),
      res,
    );
    expect(childLogger.info).toHaveBeenCalledWith(expect.objectContaining({ verifiedUid: 'uid-ctx' }));
  });

  it('verifiedUid null quando anônimo (falha token-less capturada)', () => {
    const res = mockRes();
    controller.logTrace(mockReq({ ...validPayload, outcome: 'error' }), res);
    expect(childLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ verifiedUid: null }));
  });
});
