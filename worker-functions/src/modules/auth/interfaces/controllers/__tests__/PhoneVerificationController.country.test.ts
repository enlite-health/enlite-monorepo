import type { Request, Response } from 'express';
import { PhoneVerificationController } from '../PhoneVerificationController';
import { Result } from '@shared/utils/Result';

jest.mock('@shared/logging', () => {
  const l = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { logger: { child: () => l }, reportError: jest.fn() };
});

async function start(error: string) {
  const startUc = { execute: jest.fn().mockResolvedValue(Result.fail(error)) };
  const status = jest.fn().mockReturnThis();
  const json = jest.fn();
  const res = { status, json } as unknown as Response;
  const req = { body: { phone: '+12025550123' }, user: { uid: 'uid-teste-1', email: 'a@exemplo.test' }, headers: {} } as unknown as Request;
  await new PhoneVerificationController(startUc as never, {} as never).start(req, res);
  return { status, json };
}

describe('POST /phone-verification/start: recusas do port', () => {
  it('PHONE_COUNTRY_NOT_SUPPORTED vira 400 com o code', async () => {
    const { status, json } = await start('PHONE_COUNTRY_NOT_SUPPORTED');
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ success: false, error: 'PHONE_COUNTRY_NOT_SUPPORTED', code: 'PHONE_COUNTRY_NOT_SUPPORTED' });
  });

  it.each([['RATE_LIMITED', 429], ['OTP_CHANNEL_UNAVAILABLE', 503]])('%s segue %i como antes', async (code, st) => {
    const { status } = await start(code);
    expect(status).toHaveBeenCalledWith(st);
  });
});
