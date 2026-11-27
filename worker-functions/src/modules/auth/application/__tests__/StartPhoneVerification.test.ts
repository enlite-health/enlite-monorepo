/**
 * T-F3c-134 — `start` do celular verificado: o SERVIDOR decide a finalidade pelo estado do número (AC-5). Port, repositórios e
 * canal = dublês; nenhuma chamada Twilio, nenhum telefone real.
 */
import { Result } from '@shared/utils/Result';
import { StartPhoneVerificationUseCase } from '../StartPhoneVerificationUseCase';

jest.mock('@shared/logging', () => ({
  logger: { child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) },
  reportError: jest.fn(),
  safeErrorFields: () => ({ errorName: 'Error', code: null }),
}));

const OWN = { id: 'w-own', authUid: 'uid-own', phone: undefined as string | undefined, isTest: false };
const IMPORTED = { id: 'w-imp', authUid: 'anacareimport_abc', phone: '5491155550001', isTest: false };
const REAL = { id: 'w-real', authUid: 'firebase-real-uid', phone: '5491155550001', isTest: false };

function build(opts: { own?: typeof OWN; holder?: unknown; state?: 'no_phone' | 'verified' | 'unverified' } = {}) {
  const workers = {
    findByAuthUid: jest.fn().mockResolvedValue(Result.ok(opts.own ?? OWN)),
    findByPhoneCandidates: jest.fn().mockResolvedValue(Result.ok(opts.holder ?? null)),
    hasAbsorbedRealLogin: jest.fn().mockResolvedValue(Result.ok(false)),
  };
  const verification = {
    readState: jest.fn().mockResolvedValue({ state: opts.state ?? 'no_phone', phone: null, verifiedAt: null }),
    markPhoneVerified: jest.fn(),
    methodFor: jest.fn(),
    linkProof: jest.fn(),
  };
  const otp = { start: jest.fn().mockResolvedValue({ challengeId: 'ch-1' }), check: jest.fn(), cancel: jest.fn() };
  const useCase = new StartPhoneVerificationUseCase(workers as never, verification as never, otp as never);
  return { useCase, otp, workers, verification };
}
const input = { authUid: 'uid-own', email: 'a@b.c', phone: '1155550001' };

describe('T-F3c-134 start: o servidor decide a finalidade', () => {
  it('T-F3c-134 ninguém tem o número: desafio phone_verify na ficha do token, SENT com id, máscara e prazos', async () => {
    const { useCase, otp } = build();
    const r = await useCase.execute(input);
    expect(r.getValue()).toMatchObject({ status: 'SENT', challengeId: 'ch-1', resendAfterSec: expect.any(Number), expiresInSec: 600 });
    expect(r.getValue()).not.toHaveProperty('code');
    expect((r.getValue() as { phoneMasked: string }).phoneMasked).not.toContain('1155550001');
    expect(otp.start).toHaveBeenCalledWith(expect.objectContaining({ workerId: 'w-own', purpose: 'phone_verify', phoneE164: '+5491155550001' }));
  });

  it('T-F3c-134 ficha importada tem o número: desafio claim para o número DA FICHA, SENT com CLAIM_PENDING', async () => {
    const { useCase, otp } = build({ holder: IMPORTED });
    const r = await useCase.execute(input);
    expect(r.getValue()).toMatchObject({ status: 'SENT', code: 'CLAIM_PENDING', challengeId: 'ch-1' });
    expect(otp.start).toHaveBeenCalledWith(expect.objectContaining({ workerId: 'w-imp', purpose: 'claim', phoneE164: '+5491155550001' }));
  });

  it('T-F3c-134 conta real tem o número: PHONE_IN_USE e nenhum código enviado', async () => {
    const { useCase, otp } = build({ holder: REAL });
    const r = await useCase.execute(input);
    expect(r.error).toBe('PHONE_IN_USE');
    expect(otp.start).not.toHaveBeenCalled();
  });

  it('T-F3c-134 o número já é o da ficha e já verificado: ALREADY_VERIFIED, sem envio', async () => {
    const own = { ...OWN, phone: '5491155550001' };
    const { useCase, otp } = build({ own, holder: { ...own }, state: 'verified' });
    const r = await useCase.execute(input);
    expect(r.getValue()).toMatchObject({ status: 'ALREADY_VERIFIED' });
    expect(otp.start).not.toHaveBeenCalled();
  });

  it('T-F3c-134 telefone inválido: INVALID_PHONE antes de qualquer leitura ou envio', async () => {
    const { useCase, otp, workers } = build();
    const r = await useCase.execute({ ...input, phone: '123' });
    expect(r.error).toBe('INVALID_PHONE');
    expect(workers.findByAuthUid).not.toHaveBeenCalled();
    expect(otp.start).not.toHaveBeenCalled();
  });

  it('T-F3c-134 um campo purpose no corpo é IGNORADO: a finalidade vem do servidor', async () => {
    const { useCase, otp } = build();
    await useCase.execute({ ...input, purpose: 'claim' } as never);
    expect(otp.start).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'phone_verify' }));
  });

  it('G1 telefone de outro país: PHONE_COUNTRY_NOT_SUPPORTED antes de qualquer leitura ou envio', async () => {
    const { useCase, otp, workers } = build();
    const r = await useCase.execute({ ...input, phone: '+12025550123' });
    expect(r.error).toBe('PHONE_COUNTRY_NOT_SUPPORTED');
    expect(workers.findByAuthUid).not.toHaveBeenCalled();
    expect(otp.start).not.toHaveBeenCalled();
  });

  it('G1 celular BR válido: otp.start com phoneE164 +55… e requesterUid = authUid do token', async () => {
    const { useCase, otp } = build();
    const r = await useCase.execute({ ...input, phone: '+55 11 98765-4321' });
    expect(r.getValue()).toMatchObject({ status: 'SENT' });
    expect(otp.start).toHaveBeenCalledWith(expect.objectContaining({ phoneE164: '+5511987654321', requesterUid: 'uid-own' }));
  });

  it('B10 o requesterUid é o authUid do token também no AR', async () => {
    const { useCase, otp } = build();
    await useCase.execute(input);
    expect(otp.start).toHaveBeenCalledWith(expect.objectContaining({ requesterUid: 'uid-own' }));
  });

  it('o port que recusa por país (decorator) sobe como PHONE_COUNTRY_NOT_SUPPORTED, não OTP_START_FAILED', async () => {
    const { useCase, otp } = build();
    otp.start.mockRejectedValue(new Error('PHONE_COUNTRY_NOT_SUPPORTED'));
    const r = await useCase.execute(input);
    expect(r.error).toBe('PHONE_COUNTRY_NOT_SUPPORTED');
  });

  it.each(['RATE_LIMITED', 'OTP_CHANNEL_UNAVAILABLE'])('%s do port segue como antes', async (code) => {
    const { useCase, otp } = build();
    otp.start.mockRejectedValue(new Error(code));
    expect((await useCase.execute(input)).error).toBe(code);
  });
});
