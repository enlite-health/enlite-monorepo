/**
 * ClaimController `start`: os erros do OtpChallengePort chegam ao cliente com o status certo e o mesmo `code`
 * (429 `RATE_LIMITED` do limite por telefone/ficha; 503 `OTP_CHANNEL_UNAVAILABLE` do canal), sem texto interno e sem virar 500.
 */
import { Request, Response } from 'express';
import { Result } from '@shared/utils/Result';
import { ClaimController } from '../ClaimController';

jest.mock('@shared/logging', () => ({
  logger: { child: jest.fn().mockReturnValue({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) },
  reportError: jest.fn(),
}));

const req = { body: { phone: '+5491155261243' }, user: { uid: 'u1', email: 'joana@gmail.com' }, headers: {}, ip: '127.0.0.1' } as unknown as Request;

function res(): [Response, jest.Mock, jest.Mock] {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  return [{ status, json } as unknown as Response, status, json];
}

describe('ClaimController.start — erros do port', () => {
  it.each([
    ['RATE_LIMITED', 429],
    ['OTP_CHANNEL_UNAVAILABLE', 503],
  ])('%s → %i com o mesmo code no corpo e sem 500', async (error, httpStatus) => {
    const start = { execute: jest.fn().mockResolvedValue(Result.fail(error)) };
    const [r, status, json] = res();
    await new ClaimController(start as never, { execute: jest.fn() } as never, { execute: jest.fn() } as never).start(req, r);
    expect(status).toHaveBeenCalledWith(httpStatus);
    expect(json).toHaveBeenCalledWith({ success: false, error, code: error });
    expect(status).not.toHaveBeenCalledWith(500);
  });

  it('PHONE_COUNTRY_NOT_SUPPORTED → 400 com { success, error, code } e sem 500', async () => {
    const error = 'PHONE_COUNTRY_NOT_SUPPORTED';
    const start = { execute: jest.fn().mockResolvedValue(Result.fail(error)) };
    const [r, status, json] = res();
    await new ClaimController(start as never, { execute: jest.fn() } as never, { execute: jest.fn() } as never).start(req, r);
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ success: false, error, code: error });
    expect(status).not.toHaveBeenCalledWith(500);
  });
});
