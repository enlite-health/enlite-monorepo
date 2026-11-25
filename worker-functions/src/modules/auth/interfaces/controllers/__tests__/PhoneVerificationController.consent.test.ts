import type { Request, Response } from 'express';
import { PhoneVerificationController } from '../PhoneVerificationController';

jest.mock('@shared/logging', () => {
  const l = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { logger: { child: () => l }, reportError: jest.fn() };
});

const base = { phone: '+5491155550001', challengeId: 'ch-1', code: '482913' };
function run(extra: Record<string, unknown>, outcome: unknown = { ok: true, status: 'VERIFIED', phoneMasked: '+54 9 11 ****-0001', verifiedAt: new Date() }) {
  const confirm = { execute: jest.fn().mockResolvedValue(outcome) };
  const status = jest.fn().mockReturnThis();
  const res = { status, json: jest.fn() } as unknown as Response;
  const req = { body: { ...base, ...extra }, user: { uid: 'u', email: 'a@exemplo.test' }, headers: {} } as unknown as Request;
  return new PhoneVerificationController({} as never, confirm as never).confirm(req, res).then(() => ({ confirm, status }));
}

describe('POST /phone-verification/confirm: campo consentAcceptedAt', () => {
  it('string ISO é repassada ao caso de uso', async () => {
    const { confirm, status } = await run({ consentAcceptedAt: '2026-11-24T10:00:00Z' });
    expect(confirm.execute).toHaveBeenCalledWith(expect.objectContaining({ consentAcceptedAt: '2026-11-24T10:00:00Z' }));
    expect(status).toHaveBeenCalledWith(200);
  });
  it('ausente: o caso de uso recebe undefined (sem aceite)', async () => {
    const { confirm } = await run({});
    expect(confirm.execute.mock.calls[0][0].consentAcceptedAt).toBeUndefined();
  });
  it.each([[123], [true], [{}], [null]])('tipo %j: 400 INVALID_CONSENT_AT sem chamar o caso de uso', async (v) => {
    const { confirm, status } = await run({ consentAcceptedAt: v });
    expect(status).toHaveBeenCalledWith(400);
    expect(confirm.execute).not.toHaveBeenCalled();
  });
  it('INVALID_CONSENT_AT do caso de uso sai como 400 com o code', async () => {
    const { status } = await run({ consentAcceptedAt: 'ontem' }, { ok: false, code: 'INVALID_CONSENT_AT' });
    expect(status).toHaveBeenCalledWith(400);
  });
});
