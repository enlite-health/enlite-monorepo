/**
 * T-F3c-139 — `start` e `confirm` do celular verificado não logam telefone (nem mascarado), nem código, nem nome ou e-mail: só
 * `workerIdHash` e `code` (AC-8; Ley 25.326 e as regras HIPAA-like internas). Espião do logger em TODOS os níveis e nos bindings
 * do `child`, no `start`, no `confirm` (sucesso) e no ramo `claim_conflict`.
 */
import { Result } from '@shared/utils/Result';
import { StartPhoneVerificationUseCase } from '../StartPhoneVerificationUseCase';
import { ConfirmPhoneVerificationUseCase } from '../ConfirmPhoneVerificationUseCase';

const mockLines: string[] = [];
jest.mock('@shared/logging', () => {
  const rec = (bindings: unknown) => {
    const emit = (...a: unknown[]) => { mockLines.push(JSON.stringify([bindings, a])); };
    return { info: emit, warn: emit, error: emit, debug: emit };
  };
  return { logger: { child: (b: unknown) => rec(b) }, reportError: jest.fn(), safeErrorFields: () => ({ errorName: 'Error', code: null }) };
});

const PHONE = '+5491155550001';
const CODE = '482913';
const EMAIL = 'maria.gomez@example.com';
const NAME = 'Maria Gomez';
const OWN = { id: 'w-own', authUid: 'uid-own', phone: undefined as string | undefined, isTest: false, firstName: 'Maria', fullName: NAME };
const IMPORTED = { id: 'w-imp', authUid: 'anacareimport_abc', phone: '5491155550001', isTest: false };

const workers = (holder: unknown) => ({
  findByAuthUid: jest.fn().mockResolvedValue(Result.ok(OWN)),
  findByPhoneCandidates: jest.fn().mockResolvedValue(Result.ok(holder)),
  hasAbsorbedRealLogin: jest.fn().mockResolvedValue(Result.ok(false)),
});
const verification = () => ({
  readState: jest.fn().mockResolvedValue({ state: 'verified', phone: '5491155550001', verifiedAt: new Date('2026-11-20T15:00:00Z') }),
  markPhoneVerified: jest.fn().mockResolvedValue(undefined),
  methodFor: jest.fn().mockResolvedValue({ method: 'otp_whatsapp_template', challengeId: 'ch-1' }),
  linkProof: jest.fn(),
});

function limpo(): void {
  const tudo = mockLines.join('\n');
  expect(mockLines.length).toBeGreaterThan(0); // controle positivo: o espião enxerga log
  expect(tudo).not.toContain('+54');
  expect(tudo).not.toMatch(/\d{8,}/);
  expect(tudo).not.toContain(CODE);
  expect(tudo).not.toContain(EMAIL);
  expect(tudo).not.toContain(NAME);
  expect(tudo).not.toContain('Maria');
  expect(tudo).not.toContain('1155550001');
}

beforeEach(() => { mockLines.length = 0; });

describe('T-F3c-139 sem PII em log', () => {
  it('T-F3c-139 start (phone_verify e claim) só leva workerIdHash e code', async () => {
    for (const holder of [null, IMPORTED]) {
      const otp = { start: jest.fn().mockResolvedValue({ challengeId: 'ch-1' }), check: jest.fn(), cancel: jest.fn() };
      const r = await new StartPhoneVerificationUseCase(workers(holder) as never, verification() as never, otp as never).execute({
        authUid: 'uid-own', email: EMAIL, phone: PHONE,
      });
      expect(r.isSuccess).toBe(true);
    }
    expect(mockLines.some((l) => l.includes('workerIdHash'))).toBe(true);
    limpo();
  });

  it('T-F3c-139 confirm (sucesso e código errado) só leva workerIdHash e code', async () => {
    const claim = { execute: jest.fn() };
    const mk = (check: unknown) =>
      new ConfirmPhoneVerificationUseCase(workers(null) as never, verification() as never, { check } as never, claim as never, { query: jest.fn() } as never);
    const input = { authUid: 'uid-own', email: EMAIL, phone: PHONE, challengeId: 'ch-1', code: CODE };
    expect((await mk(jest.fn().mockResolvedValue({ ok: true })).execute(input)).ok).toBe(true);
    expect((await mk(jest.fn().mockResolvedValue({ ok: false, code: 'INVALID_OTP' })).execute(input)).ok).toBe(false);
    limpo();
  });

  it('T-F3c-139 o ramo claim_conflict loga só code, referência opaca e workerIdHash', async () => {
    const claim = { execute: jest.fn().mockResolvedValue(Result.fail('CLAIM_CONFLICT')) };
    const useCase = new ConfirmPhoneVerificationUseCase(
      workers(IMPORTED) as never, verification() as never, { check: jest.fn() } as never, claim as never, { query: jest.fn() } as never,
    );
    const out = await useCase.execute({ authUid: 'uid-own', email: EMAIL, phone: PHONE, challengeId: 'ch-1', code: CODE });
    expect(out).toMatchObject({ ok: false, code: 'CLAIM_CONFLICT' });
    expect(mockLines.some((l) => l.includes('claim_conflict'))).toBe(true);
    limpo();
  });
});
