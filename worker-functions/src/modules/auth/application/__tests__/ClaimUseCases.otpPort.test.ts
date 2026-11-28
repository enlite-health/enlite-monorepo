/**
 * Claim sobre o OtpChallengePort (D758, PR-INF-47): finalidade `claim`, mapeamento de RATE_LIMITED / canal, telefone GRAVADO na
 * conferência (DP-21) e as falhas do port repassadas sem virar sucesso. Port = dublê; nenhuma chamada Twilio, nenhum telefone em log.
 */
import { Result } from '@shared/utils/Result';
import { StartClaimUseCase } from '../StartClaimUseCase';
import { ConfirmClaimUseCase } from '../ConfirmClaimUseCase';
import { OTP_CHANNEL_UNAVAILABLE, OTP_RATE_LIMITED } from '../../ports/OtpChallengePort';

jest.mock('@shared/logging', () => ({
  logger: { child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) },
  reportError: jest.fn(),
  safeErrorFields: (e: unknown) => ({ errorName: e instanceof Error ? e.name : typeof e, code: (e as { code?: string } | null)?.code ?? null }),
}));

const FICHA = { id: 'w-1', authUid: 'anacareimport_abc', phone: '5491155550001', isTest: false };
const repo = () => ({
  findByPhoneCandidates: jest.fn().mockResolvedValue(Result.ok(FICHA)),
  findById: jest.fn().mockResolvedValue(Result.ok(FICHA)),
  findByAuthUid: jest.fn().mockResolvedValue(Result.ok(null)),
  hasAbsorbedRealLogin: jest.fn().mockResolvedValue(Result.ok(false)),
  updateImportedWorkerData: jest.fn().mockResolvedValue(Result.ok(FICHA)),
});
const port = () => ({ start: jest.fn(), check: jest.fn(), cancel: jest.fn() });

describe('StartClaimUseCase sobre o port', () => {
  it('envia com finalidade claim, para o telefone da FICHA em E.164, e devolve o id do desafio', async () => {
    const p = port();
    p.start.mockResolvedValue({ challengeId: 'ch-1' });
    const r = await new StartClaimUseCase(repo() as never, p as never).execute({ authUid: 'u', email: 'a@b.c', phone: '1155550001' });
    expect(r.getValue()).toEqual({ phoneMasked: expect.any(String), verificationSid: 'ch-1' });
    expect(p.start).toHaveBeenCalledWith(expect.objectContaining({ workerId: 'w-1', purpose: 'claim', phoneE164: '+5491155550001' }));
  });

  it.each([OTP_RATE_LIMITED, OTP_CHANNEL_UNAVAILABLE])('o erro %s do port sai com o mesmo código (nunca TWILIO_ERROR)', async (code) => {
    const p = port();
    p.start.mockRejectedValue(new Error(code));
    const r = await new StartClaimUseCase(repo() as never, p as never).execute({ authUid: 'u', email: 'a@b.c', phone: '1155550001' });
    expect(r.error).toBe(code);
  });
});

describe('ConfirmClaimUseCase sobre o port', () => {
  const input = { verificationSid: 'ch-1', otp: '123456', authUid: 'u', email: 'a@b.c', candidateWorkerId: 'w-1' };

  it('confere o desafio contra o telefone GRAVADO na ficha (E.164), não contra o do cliente', async () => {
    const p = port();
    p.check.mockResolvedValue({ ok: true });
    await new ConfirmClaimUseCase(repo() as never, p as never).execute(input);
    expect(p.check).toHaveBeenCalledWith(
      expect.objectContaining({ challengeId: 'ch-1', workerId: 'w-1', phoneOnRecord: '+5491155550001', code: '123456' }),
    );
  });

  it.each(['INVALID_OTP', 'EXPIRED_OTP', 'OTP_ALREADY_USED'] as const)('port recusa com %s: o código sai igual e a ficha NÃO é transferida', async (code) => {
    const p = port();
    p.check.mockResolvedValue({ ok: false, code });
    const r = repo();
    const res = await new ConfirmClaimUseCase(r as never, p as never).execute(input);
    expect(res.error).toBe(code);
    expect(r.updateImportedWorkerData).not.toHaveBeenCalled();
  });
});
