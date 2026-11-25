/**
 * Aceite da política no `phone/confirm` (spec 077, CT-13): a hora em que a caixa foi marcada viaja até aqui e entra no trio
 * de `workers` (D514) por COALESCE. Sem aceite = nada gravado. Hora fora da janela = recusa ANTES de qualquer efeito.
 */
import { Result } from '@shared/utils/Result';
import { ConfirmPhoneVerificationUseCase } from '../ConfirmPhoneVerificationUseCase';

jest.mock('@shared/logging', () => {
  const l = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { logger: { child: () => l }, reportError: jest.fn(), safeErrorFields: () => ({ errorName: 'Error', code: null }) };
});

const OWN = { id: 'w-own', authUid: 'uid-own', phone: undefined, isTest: false };
const IMPORTED = { id: 'w-imp', authUid: 'anacareimport_abc', phone: '5491155550001', isTest: false };
const input = { authUid: 'uid-own', email: 'a@exemplo.test', phone: '+5491155550001', challengeId: 'ch-1', code: '482913' };
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function build(holder: unknown, over: { recordConsent?: jest.Mock; check?: jest.Mock } = {}) {
  const workers = {
    findByAuthUid: jest.fn().mockResolvedValue(Result.ok(OWN)),
    findByPhoneCandidates: jest.fn().mockResolvedValue(Result.ok(holder)),
    hasAbsorbedRealLogin: jest.fn().mockResolvedValue(Result.ok(false)),
    recordConsentIfMissing: over.recordConsent ?? jest.fn().mockResolvedValue(true),
  };
  const verification = {
    readState: jest.fn().mockResolvedValue({ state: 'verified', phone: '5491155550001', verifiedAt: new Date() }),
    markPhoneVerified: jest.fn().mockResolvedValue(undefined),
    methodFor: jest.fn().mockResolvedValue({ method: 'otp_whatsapp_template', challengeId: 'ch-1' }),
  };
  const challenges = { check: over.check ?? jest.fn().mockResolvedValue({ ok: true }) };
  const claim = { execute: jest.fn().mockResolvedValue(Result.ok({ id: OWN.id })) };
  const uc = new ConfirmPhoneVerificationUseCase(workers as never, verification as never, challenges as never, claim as never, { query: jest.fn() } as never);
  return { uc, workers, verification, challenges, claim };
}

describe('phone/confirm com aceite explícito', () => {
  it('phone_verify: grava o aceite na ficha do token com a hora recebida, ANTES de consumir o OTP', async () => {
    const h = build(null);
    const at = minutesAgo(10);
    const r = await h.uc.execute({ ...input, consentAcceptedAt: at });
    expect(r.ok).toBe(true);
    expect(h.workers.recordConsentIfMissing).toHaveBeenCalledWith(OWN.id, new Date(at));
    expect(h.workers.recordConsentIfMissing.mock.invocationCallOrder[0]).toBeLessThan(h.challenges.check.mock.invocationCallOrder[0]);
  });

  it('phone_verify sem consentAcceptedAt: nada de consentimento é gravado', async () => {
    const h = build(null);
    expect((await h.uc.execute(input)).ok).toBe(true);
    expect(h.workers.recordConsentIfMissing).not.toHaveBeenCalled();
  });

  it('claim (ficha importada): a hora segue no pedido do claim, que grava na transação da união', async () => {
    const h = build(IMPORTED);
    const at = minutesAgo(2);
    const r = await h.uc.execute({ ...input, consentAcceptedAt: at });
    expect(r.ok).toBe(true);
    expect(h.claim.execute.mock.calls[0][0].consentAt).toEqual(new Date(at));
    expect(h.workers.recordConsentIfMissing).not.toHaveBeenCalled();
  });

  it('claim sem consentAcceptedAt: o pedido do claim não leva consentAt', async () => {
    const h = build(IMPORTED);
    await h.uc.execute(input);
    expect(h.claim.execute.mock.calls[0][0].consentAt).toBeUndefined();
  });

  it.each([['futuro (+1 h)', () => new Date(Date.now() + 3_600_000).toISOString()], ['velha (25 h)', () => minutesAgo(25 * 60)], ['ilegível', () => 'ontem']])(
    'hora %s: INVALID_CONSENT_AT e nenhum efeito (OTP intacto, nada gravado)',
    async (_n, mk) => {
      for (const holder of [null, IMPORTED]) {
        const h = build(holder);
        const r = await h.uc.execute({ ...input, consentAcceptedAt: mk() });
        expect(r).toEqual({ ok: false, code: 'INVALID_CONSENT_AT' });
        expect(h.challenges.check).not.toHaveBeenCalled();
        expect(h.claim.execute).not.toHaveBeenCalled();
        expect(h.workers.recordConsentIfMissing).not.toHaveBeenCalled();
        expect(h.verification.markPhoneVerified).not.toHaveBeenCalled();
      }
    },
  );

  it('ficha não recebeu o aceite (false ou erro): CONSENT_NOT_RECORDED, OTP não consumido', async () => {
    for (const rec of [jest.fn().mockResolvedValue(false), jest.fn().mockRejectedValue(new Error('db'))]) {
      const h = build(null, { recordConsent: rec });
      const r = await h.uc.execute({ ...input, consentAcceptedAt: minutesAgo(1) });
      expect(r).toEqual({ ok: false, code: 'CONSENT_NOT_RECORDED' });
      expect(h.challenges.check).not.toHaveBeenCalled();
    }
  });
});
