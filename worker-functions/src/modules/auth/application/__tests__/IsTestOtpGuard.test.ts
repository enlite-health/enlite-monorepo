jest.mock('@shared/logging', () => ({
  logger: { child: jest.fn() },
  reportError: jest.fn(),
  loggingAls: { run: jest.fn(), getStore: jest.fn().mockReturnValue(undefined) },
}));

import type { Pool } from 'pg';
import { logger } from '@shared/logging';
import { Result } from '@shared/utils/Result';
import { IsTestOtpGuardedVerify } from '../IsTestOtpGuard';
import { StartClaimUseCase } from '../StartClaimUseCase';
import { InitWorkerUseCase } from '@modules/worker/application/InitWorkerUseCase';
import { AccountLinkService } from '@modules/account-link/AccountLinkService';

const TEST_TOKEN = 'qa.signup.run1@enlite.test';
const REAL_TOKEN = 'joana.silva@gmail.com';
const FICHA_PHONE = '+5491155261243';
const STUB_CODE = '493017'; // código de teste (no prd vem do secret e2e-otp-code-prd)

let infoLog: jest.Mock;
beforeEach(() => {
  infoLog = jest.fn();
  (logger.child as jest.Mock).mockReturnValue({ info: infoLog, warn: jest.fn(), error: jest.fn() });
});

/** Dublê do sender real (Twilio): o espião que prova 0 chamadas para ficha de teste. */
function makeSender() {
  return {
    startVerification: jest.fn().mockResolvedValue({ verificationSid: 'VE-real' }),
    checkVerification: jest.fn().mockResolvedValue({ valid: false, status: 'pending' as const }),
  };
}
const guarded = (sender: ReturnType<typeof makeSender>) => new IsTestOtpGuardedVerify(sender, () => STUB_CODE, 'chave-de-teste');

describe('IsTestOtpGuard (FR-95/DP-23) — ponto único de envio', () => {
  it('T-F3c-23 ficha is_test + token @enlite.test: sender NÃO chamado e log otp_suppressed_is_test', async () => {
    const sender = makeSender();
    const out = await guarded(sender).startVerification(FICHA_PHONE, { fichaIsTest: true, tokenEmail: TEST_TOKEN });
    expect(sender.startVerification).toHaveBeenCalledTimes(0);
    expect(out.verificationSid).toMatch(/^SUPPRESSED_/);
    expect(infoLog).toHaveBeenCalledWith({ msg: 'otp_suppressed_is_test' });
    expect(out.verificationSid).not.toContain(FICHA_PHONE.replace('+', '')); // sid opaco: nada de telefone em log/trilha
  });

  it('T-F3c-23 ficha real (token de teste ou não): sender chamado 1 vez', async () => {
    const sender = makeSender();
    await guarded(sender).startVerification(FICHA_PHONE, { fichaIsTest: false, tokenEmail: TEST_TOKEN });
    await guarded(sender).startVerification(FICHA_PHONE); // sem contexto = envio normal
    expect(sender.startVerification).toHaveBeenCalledTimes(2);
  });

  it('T-F3c-23 ficha de teste com token real: sender chamado 1 vez', async () => {
    const sender = makeSender();
    const out = await guarded(sender).startVerification(FICHA_PHONE, { fichaIsTest: true, tokenEmail: REAL_TOKEN });
    expect(sender.startVerification).toHaveBeenCalledTimes(1);
    expect(out.verificationSid).toBe('VE-real');
  });

  it('T-F3c-23 código do stub = o do secret, amarrado ao telefone; errado, sem env e sid forjado não validam', async () => {
    const sender = makeSender();
    const g = guarded(sender);
    const { verificationSid } = await g.startVerification(FICHA_PHONE, { fichaIsTest: true, tokenEmail: TEST_TOKEN });

    expect(await g.checkVerification(verificationSid, STUB_CODE)).toEqual({ valid: true, status: 'approved', to: FICHA_PHONE });
    expect((await g.checkVerification(verificationSid, '000000')).valid).toBe(false);
    expect((await new IsTestOtpGuardedVerify(sender, () => undefined, 'chave-de-teste').checkVerification(verificationSid, STUB_CODE)).valid).toBe(false);

    // sid fabricado para o telefone de uma ficha REAL não decifra: cai no sender (que recusa), nunca aprova
    const forged = `SUPPRESSED_${Buffer.from(FICHA_PHONE).toString('base64url')}`;
    expect((await g.checkVerification(forged, STUB_CODE)).valid).toBe(false);
    expect(sender.checkVerification).toHaveBeenCalledWith(forged, STUB_CODE);
    expect(sender.startVerification).toHaveBeenCalledTimes(0);
  });
});

describe('IsTestOtpGuard — os 3 caminhos de envio passam pela guarda', () => {
  const ctxCases = (isTest: boolean) => ({ isTest, expectedCalls: isTest ? 0 : 1 });

  it.each([true, false])('T-F3c-23 StartClaimUseCase (ficha is_test=%s)', async (isTest) => {
    const sender = makeSender();
    const ficha = { id: 'w1', authUid: 'anacareimport_+5491155261243', email: 'x@anacareimport.invalid', phone: FICHA_PHONE, isTest };
    const repo = {
      findByPhoneCandidates: jest.fn().mockResolvedValue(Result.ok(ficha)),
      hasAbsorbedRealLogin: jest.fn().mockResolvedValue(Result.ok(false)),
    };
    const uc = new StartClaimUseCase(repo as never, guarded(sender));
    const res = await uc.execute({ authUid: 'uid-1', email: TEST_TOKEN, phone: FICHA_PHONE });
    expect(res.isSuccess).toBe(true);
    expect(sender.startVerification).toHaveBeenCalledTimes(ctxCases(isTest).expectedCalls);
  });

  it.each([true, false])('T-F3c-23 InitWorkerUseCase (ficha is_test=%s)', async (isTest) => {
    const sender = makeSender();
    const ficha = { id: 'w1', authUid: 'anacareimport_+5491155261243', email: 'x@anacareimport.invalid', phone: FICHA_PHONE, isTest };
    const repo = {
      findByAuthUid: jest.fn().mockResolvedValue(Result.ok(null)),
      findByEmail: jest.fn().mockResolvedValue(Result.ok(null)),
      findByPhoneCandidates: jest.fn().mockResolvedValue(Result.ok(ficha)),
    };
    const uc = new InitWorkerUseCase(repo as never, guarded(sender));
    const res = await uc.execute({ authUid: 'uid-1', email: TEST_TOKEN, emailVerified: false, phone: FICHA_PHONE });
    expect(res.getValue()).toMatchObject({ status: 'claim_pending' });
    expect(sender.startVerification).toHaveBeenCalledTimes(ctxCases(isTest).expectedCalls);
  });

  it.each([true, false])('T-F3c-23 AccountLinkService.start (ficha dona is_test=%s)', async (isTest) => {
    const sender = makeSender();
    const pool = {
      query: jest.fn().mockImplementation((sql: string) => {
        if (sql.includes('WHERE auth_uid')) return Promise.resolve({ rows: [{ id: 'me', email: TEST_TOKEN, auth_uid: 'uid-1', phone: null, updated_at: new Date(), merged_into_id: null }] });
        if (sql.includes('phone = ANY')) return Promise.resolve({ rows: [{ id: 'owner', email: 'o@x.com', auth_uid: 'FirebaseOld', phone: '5491155261243', updated_at: new Date(), is_test: isTest }] });
        if (sql.includes("event = 'started'")) return Promise.resolve({ rows: [{ cnt: '0' }] });
        return Promise.resolve({ rows: [] });
      }),
    } as unknown as Pool;
    const service = new AccountLinkService(pool, { twilio: sender as never, adminMerge: {} as never, encryption: {} as never });
    await service.start('uid-1', '1155261243', TEST_TOKEN);
    expect(sender.startVerification).toHaveBeenCalledTimes(ctxCases(isTest).expectedCalls);
  });
});
