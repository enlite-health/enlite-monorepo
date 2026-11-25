import type { Request, Response } from 'express';
import { Result } from '@shared/utils/Result';
import { ClaimController } from '../ClaimController';

jest.mock('@shared/logging', () => {
  const l = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { logger: { child: () => l }, reportError: jest.fn() };
});

const body = { verificationSid: 'VE_X', otp: '123456', candidateWorkerId: 'w-imp' };
const res = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() }) as unknown as Response;
async function confirmWith(extra: Record<string, unknown>) {
  const confirmClaim = { execute: jest.fn().mockResolvedValue(Result.ok({ id: 'w' })) };
  await new ClaimController({} as never, confirmClaim as never).confirm(
    { body: { ...body, ...extra }, user: { uid: 'u', email: 'a@exemplo.test' }, headers: {}, ip: '127.0.0.1' } as unknown as Request,
    res(),
  );
  return confirmClaim.execute.mock.calls[0][0];
}

describe('POST /api/auth/claim/confirm: aceite só se explícito (web marcou a caixa)', () => {
  it('lgpdOptIn:true (a web marcou a caixa) vira consentAt', async () => {
    expect((await confirmWith({ lgpdOptIn: true })).consentAt).toBeInstanceOf(Date);
  });
  it.each([[{}], [{ lgpdOptIn: false }], [{ lgpdOptIn: 'true' }], [{ lgpdOptIn: 1 }]])('%j não presume aceite (consentAt ausente)', async (extra) => {
    expect((await confirmWith(extra)).consentAt).toBeUndefined();
  });
});
