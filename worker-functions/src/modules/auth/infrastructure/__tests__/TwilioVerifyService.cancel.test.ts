/** T-F3c-19 — DT-52/C-49: o reenvio cancela a verificação anterior antes de abrir outra. Dublê do Twilio, sem rede. */
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

describe('TwilioVerifyService — reenvio cancela o código anterior', () => {
  it('T-F3c-19 ordem: cancela a pendente do telefone e só então cria a nova', async () => {
    mockUpdate.mockResolvedValue({ status: 'canceled' });
    mockCreate.mockResolvedValue({ sid: 'VE_NOVA', status: 'pending', dateUpdated: null });

    await new TwilioVerifyService().startVerification(PHONE);

    expect(calls).toEqual([`cancel:${PHONE}`, 'create']);
  });

  it('T-F3c-19 status: a verificação anterior recebe status=canceled e a nova sai com outro sid', async () => {
    mockUpdate.mockResolvedValue({ status: 'canceled' });
    mockCreate.mockResolvedValueOnce({ sid: 'VE_1', status: 'pending', dateUpdated: null });
    mockCreate.mockResolvedValueOnce({ sid: 'VE_2', status: 'pending', dateUpdated: null });

    const service = new TwilioVerifyService();
    const first = await service.startVerification(PHONE);
    const second = await service.startVerification(PHONE);

    expect(mockUpdate).toHaveBeenCalledWith({ status: 'canceled' });
    expect(mockUpdate).toHaveBeenCalledTimes(2);
    expect(first.verificationSid).not.toBe(second.verificationSid);
  });
});
