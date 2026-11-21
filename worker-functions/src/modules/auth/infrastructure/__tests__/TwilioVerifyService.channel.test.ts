/** T-F3c-20 — D732/DP-22 e D758.4: Verify é plano B só no canal whatsapp, sem SMS e sem fallback. Dublê do Twilio, sem rede. */
const calls: string[] = [];
const mockUpdate = jest.fn();
const mockCreate = jest.fn();
const mockServices = jest.fn();

jest.mock('twilio', () =>
  jest.fn().mockReturnValue({ verify: { v2: { services: (sid: string) => mockServices(sid) } } }),
);
jest.mock('@shared/logging', () => ({
  logger: { child: jest.fn().mockReturnValue({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }), warn: jest.fn(), info: jest.fn(), error: jest.fn() },
  reportError: jest.fn(),
}));

import { TwilioVerifyService } from '../TwilioVerifyService';

const PHONE = '+5491100000000';
const OLD_ENV = process.env;

beforeEach(() => {
  jest.clearAllMocks();
  calls.length = 0;
  process.env = { ...OLD_ENV, TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'tok', TWILIO_VERIFY_SERVICE_SID: 'VAtest' };
  delete process.env.E2E_OTP_BYPASS;
  mockServices.mockReturnValue({
    verifications: Object.assign(
      (to: string) => ({ update: (body: unknown) => { calls.push(`cancel:${to}`); return mockUpdate(body); } }),
      { create: (body: unknown) => { calls.push('create'); return mockCreate(body); } },
    ),
  });
});
afterEach(() => { process.env = OLD_ENV; });

describe('TwilioVerifyService — canal só whatsapp', () => {
  it('T-F3c-20 canal: o envio pede sempre channel=whatsapp', async () => {
    mockUpdate.mockResolvedValue({ status: 'canceled' });
    mockCreate.mockResolvedValue({ sid: 'VE_X', status: 'pending', dateUpdated: null });

    await new TwilioVerifyService().startVerification(PHONE);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith({ to: PHONE, channel: 'whatsapp' });
  });

  it('T-F3c-20 erro: falha do Twilio vira OTP_CHANNEL_UNAVAILABLE sem 2ª chamada com outro canal', async () => {
    mockUpdate.mockResolvedValue({ status: 'canceled' });
    mockCreate.mockRejectedValue(Object.assign(new Error('boom'), { code: 63016 }));

    await expect(new TwilioVerifyService().startVerification(PHONE)).rejects.toThrow('OTP_CHANNEL_UNAVAILABLE');

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).not.toHaveBeenCalledWith(expect.objectContaining({ channel: 'sms' }));
  });
});
