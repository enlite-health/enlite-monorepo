/**
 * T-F3c-138 — `GET /api/workers/me` devolve `phoneVerification` lido do repositório (função derivada do banco), com o número
 * mascarado no servidor e `verifiedAt` só em `verified` (AC-13). Repositórios = dublês; nada de banco aqui.
 */
import { Result } from '@shared/utils/Result';
import { GetWorkerProgressUseCase } from '../GetWorkerProgressUseCase';

const WORKER = { id: 'w-1', authUid: 'uid-1', email: 'a@b.c', status: 'INCOMPLETE_REGISTER' };
const PHONE = '5491155550001';
const VERIFIED_AT = new Date('2026-11-20T15:00:00Z');

function build(read: unknown) {
  const workers = { findByAuthUid: jest.fn().mockResolvedValue(Result.ok(WORKER)) };
  const verification = { readState: jest.fn().mockResolvedValue(read) };
  return new GetWorkerProgressUseCase(workers as never, verification as never);
}

describe('T-F3c-138 progress devolve phoneVerification', () => {
  it('T-F3c-138 verified: com verifiedAt e o número mascarado', async () => {
    const r = await build({ state: 'verified', phone: PHONE, verifiedAt: VERIFIED_AT }).executeWithPhoneVerification('uid-1');
    const { phoneVerification } = r.getValue();
    expect(phoneVerification).toEqual({ state: 'verified', phoneMasked: expect.any(String), verifiedAt: VERIFIED_AT.toISOString() });
    expect(phoneVerification?.phoneMasked).not.toContain(PHONE);
    expect(phoneVerification?.phoneMasked?.endsWith('0001')).toBe(true);
  });

  it('T-F3c-138 unverified: com o número mascarado e SEM verifiedAt', async () => {
    const r = await build({ state: 'unverified', phone: PHONE, verifiedAt: VERIFIED_AT }).executeWithPhoneVerification('uid-1');
    const { phoneVerification } = r.getValue();
    expect(phoneVerification).toMatchObject({ state: 'unverified', verifiedAt: null });
    expect(phoneVerification?.phoneMasked).toEqual(expect.any(String));
    expect(phoneVerification?.phoneMasked).not.toContain(PHONE);
  });

  it('T-F3c-138 no_phone: sem máscara e sem verifiedAt', async () => {
    const r = await build({ state: 'no_phone', phone: null, verifiedAt: null }).executeWithPhoneVerification('uid-1');
    expect(r.getValue().phoneVerification).toEqual({ state: 'no_phone', phoneMasked: null, verifiedAt: null });
  });
});
