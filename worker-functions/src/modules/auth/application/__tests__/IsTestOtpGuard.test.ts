jest.mock('@shared/logging', () => ({
  logger: { child: jest.fn() },
  reportError: jest.fn(),
  loggingAls: { run: jest.fn(), getStore: jest.fn().mockReturnValue(undefined) },
}));

jest.mock('@modules/account-link/accountLinkNotice', () => ({ sendLinkedNoticeEmail: jest.fn().mockResolvedValue(undefined) }));

import type { Pool } from 'pg';
import { logger } from '@shared/logging';
import { Result } from '@shared/utils/Result';
import { IsTestOtpGuardedVerify } from '../../infrastructure/IsTestOtpGuardedVerify';
import { StartClaimUseCase } from '../StartClaimUseCase';
import { InitWorkerUseCase } from '@modules/worker/application/InitWorkerUseCase';
import { AccountLinkService } from '@modules/account-link/AccountLinkService';
import { ConfirmClaimUseCase } from '../ConfirmClaimUseCase';
import { TwilioVerifyOtpAdapter } from '../../infrastructure/TwilioVerifyOtpAdapter';

const TEST_TOKEN = 'qa.signup.run1@enlite.test';
const REAL_TOKEN = 'joana.silva@gmail.com';
const FICHA_PHONE = '+5491155261243';
const STUB_CODE = '493017'; // código de teste (no prd vem do secret e2e-otp-code-prd)

afterAll(() => { delete process.env.E2E_OTP_CODE; });

const WORKER_ID = 'w-alvo';
const OUTRO_ID = 'w-outro';

let infoLog: jest.Mock;
let warnLog: jest.Mock;
let errorLog: jest.Mock;
beforeEach(() => {
  infoLog = jest.fn();
  warnLog = jest.fn();
  errorLog = jest.fn();
  (logger.child as jest.Mock).mockReturnValue({ info: infoLog, warn: warnLog, error: errorLog });
});

/** Dublê do sender real (Twilio): o espião que prova 0 chamadas para ficha de teste. */
function makeSender() {
  return {
    startVerification: jest.fn().mockResolvedValue({ verificationSid: 'VE-real' }),
    checkVerification: jest.fn().mockResolvedValue({ valid: false, status: 'pending' as const }),
  };
}
const guarded = (sender: ReturnType<typeof makeSender>, now?: () => number) =>
  new IsTestOtpGuardedVerify(sender, () => STUB_CODE, 'chave-de-teste', now);
const sendCtx = (o: { isTest?: boolean; token?: string; id?: string } = {}) => ({
  workerId: o.id ?? WORKER_ID, fichaIsTest: o.isTest ?? true, tokenEmail: o.token ?? TEST_TOKEN,
});
const confirmCtx = (o: { isTest?: boolean; token?: string; id?: string } = {}) => ({
  workerId: o.id ?? WORKER_ID, tokenEmail: o.token ?? TEST_TOKEN, fichaIsTest: async () => o.isTest ?? true,
});

describe('IsTestOtpGuard (FR-95/DP-23) — ponto único de envio', () => {
  it('T-F3c-23 ficha is_test + token @enlite.test: sender NÃO chamado e log otp_suppressed_is_test', async () => {
    const sender = makeSender();
    const out = await guarded(sender).startVerification(FICHA_PHONE, sendCtx());
    expect(sender.startVerification).toHaveBeenCalledTimes(0);
    expect(out.verificationSid).toMatch(/^SUPPRESSED_/);
    expect(infoLog).toHaveBeenCalledWith({ msg: 'otp_suppressed_is_test' });
    expect(out.verificationSid).not.toContain(FICHA_PHONE.replace('+', '')); // sid opaco: nada de telefone em log/trilha
  });

  it('T-F3c-23 ficha real (token de teste ou não): sender chamado 1 vez', async () => {
    const sender = makeSender();
    await guarded(sender).startVerification(FICHA_PHONE, sendCtx({ isTest: false }));
    await guarded(sender).startVerification(FICHA_PHONE); // sem contexto = envio normal
    expect(sender.startVerification).toHaveBeenCalledTimes(2);
  });

  it('T-F3c-23 ficha de teste com token real: sender chamado 1 vez', async () => {
    const sender = makeSender();
    const out = await guarded(sender).startVerification(FICHA_PHONE, sendCtx({ token: REAL_TOKEN }));
    expect(sender.startVerification).toHaveBeenCalledTimes(1);
    expect(out.verificationSid).toBe('VE-real');
  });

  it('T-F3c-23 caminho feliz: ficha is_test + token de teste + mesma ficha aceita o código do secret, amarrado ao telefone', async () => {
    const sender = makeSender();
    const g = guarded(sender);
    const { verificationSid } = await g.startVerification(FICHA_PHONE, sendCtx());
    expect(await g.checkVerification(verificationSid, STUB_CODE, confirmCtx())).toEqual({ valid: true, status: 'approved', to: FICHA_PHONE });
    expect((await g.checkVerification(verificationSid, '000000', confirmCtx())).valid).toBe(false);
    expect(sender.startVerification).toHaveBeenCalledTimes(0);
  });

  it('T-F3c-23 confirm: ficha REAL + código de teste é recusada', async () => {
    const sender = makeSender();
    const g = guarded(sender);
    const { verificationSid } = await g.startVerification(FICHA_PHONE, sendCtx());
    const out = await g.checkVerification(verificationSid, STUB_CODE, confirmCtx({ isTest: false }));
    expect(out.valid).toBe(false);
    expect(out.to).toBeUndefined();
    expect(warnLog).toHaveBeenCalledWith({ msg: 'otp_suppressed_confirm_refused', reason: 'ficha_not_test' });
  });

  it('T-F3c-23 confirm: ficha is_test de OUTRO worker é recusada (workerId lacrado no sid)', async () => {
    const g = guarded(makeSender());
    const { verificationSid } = await g.startVerification(FICHA_PHONE, sendCtx());
    const out = await g.checkVerification(verificationSid, STUB_CODE, confirmCtx({ id: OUTRO_ID }));
    expect(out.valid).toBe(false);
    expect(warnLog).toHaveBeenCalledWith({ msg: 'otp_suppressed_confirm_refused', reason: 'other_worker' });
  });

  it('T-F3c-23 confirm: sid vencido (10 min) é recusado; dentro da validade aceita', async () => {
    let t = 1_000_000;
    const g = guarded(makeSender(), () => t);
    const { verificationSid } = await g.startVerification(FICHA_PHONE, sendCtx());
    t += 9 * 60_000;
    expect((await g.checkVerification(verificationSid, STUB_CODE, confirmCtx())).valid).toBe(true);
    t += 2 * 60_000;
    expect((await g.checkVerification(verificationSid, STUB_CODE, confirmCtx())).valid).toBe(false);
    expect(warnLog).toHaveBeenCalledWith({ msg: 'otp_suppressed_confirm_refused', reason: 'expired' });
  });

  it('T-F3c-23 confirm: token que não é @enlite.test é recusado', async () => {
    const g = guarded(makeSender());
    const { verificationSid } = await g.startVerification(FICHA_PHONE, sendCtx());
    expect((await g.checkVerification(verificationSid, STUB_CODE, confirmCtx({ token: REAL_TOKEN }))).valid).toBe(false);
    expect(warnLog).toHaveBeenCalledWith({ msg: 'otp_suppressed_confirm_refused', reason: 'token_not_test' });
  });

  it('T-F3c-23 confirm sem contexto e sid forjado nunca aprovam', async () => {
    const sender = makeSender();
    const g = guarded(sender);
    const { verificationSid } = await g.startVerification(FICHA_PHONE, sendCtx());
    expect((await g.checkVerification(verificationSid, STUB_CODE)).valid).toBe(false);
    const forged = `SUPPRESSED_${Buffer.from(FICHA_PHONE).toString('base64url')}`;
    expect((await g.checkVerification(forged, STUB_CODE, confirmCtx())).valid).toBe(false);
    expect(sender.checkVerification).toHaveBeenCalledWith(forged, STUB_CODE);
  });

  it('T-F3c-23 sem E2E_OTP_CODE: loga otp_test_code_missing (sem valor) e devolve inválido', async () => {
    const sender = makeSender();
    const g = new IsTestOtpGuardedVerify(sender, () => undefined, 'chave-de-teste');
    const { verificationSid } = await g.startVerification(FICHA_PHONE, sendCtx());
    const out = await g.checkVerification(verificationSid, STUB_CODE, confirmCtx());
    expect(out.valid).toBe(false);
    expect(errorLog).toHaveBeenCalledWith({ msg: 'otp_test_code_missing' });
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
    const uc = new StartClaimUseCase(repo as never, new TwilioVerifyOtpAdapter(guarded(sender)));
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
    const uc = new InitWorkerUseCase(repo as never, new TwilioVerifyOtpAdapter(guarded(sender)));
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
    const service = new AccountLinkService(pool, { otp: new TwilioVerifyOtpAdapter(new IsTestOtpGuardedVerify(sender as never)), adminMerge: {} as never, encryption: {} as never });
    await service.start('uid-1', '1155261243', TEST_TOKEN);
    expect(sender.startVerification).toHaveBeenCalledTimes(ctxCases(isTest).expectedCalls);
  });
});

describe('IsTestOtpGuard — o CONFIRM dos 2 fluxos relê a ficha alvo (B2)', () => {
  const fichaDb = (over: { id?: string; isTest: boolean }) => ({
    id: over.id ?? WORKER_ID, authUid: 'anacareimport_+5491155261243', email: 'x@anacareimport.invalid',
    phone: FICHA_PHONE, isTest: over.isTest,
  });

  async function claimConfirm(ficha: ReturnType<typeof fichaDb>, candidateWorkerId: string) {
    const sender = makeSender();
    const g = guarded(sender);
    const { verificationSid } = await g.startVerification(FICHA_PHONE, sendCtx());
    const repo = {
      findById: jest.fn().mockResolvedValue(Result.ok(ficha)),
      findByAuthUid: jest.fn().mockResolvedValue(Result.ok(null)),
      hasAbsorbedRealLogin: jest.fn().mockResolvedValue(Result.ok(false)),
      updateImportedWorkerData: jest.fn().mockResolvedValue(Result.ok({ id: ficha.id })),
    };
    const res = await new ConfirmClaimUseCase(repo as never, new TwilioVerifyOtpAdapter(g)).execute({
      verificationSid, otp: STUB_CODE, authUid: 'uid-1', email: TEST_TOKEN, candidateWorkerId,
    });
    return { res, repo, sender };
  }

  it('T-F3c-23 claim confirm: ficha is_test no banco + mesma ficha aceita e transfere', async () => {
    const { res, repo } = await claimConfirm(fichaDb({ isTest: true }), WORKER_ID);
    expect(res.isSuccess).toBe(true);
    expect(repo.updateImportedWorkerData).toHaveBeenCalledTimes(1);
  });

  it('T-F3c-23 claim confirm: candidateWorkerId do corpo aponta ficha REAL → INVALID_OTP, nada é transferido', async () => {
    const { res, repo } = await claimConfirm(fichaDb({ id: WORKER_ID, isTest: false }), WORKER_ID);
    expect(res.error).toBe('INVALID_OTP');
    expect(repo.updateImportedWorkerData).toHaveBeenCalledTimes(0);
  });

  it('T-F3c-23 claim confirm: candidateWorkerId de OUTRA ficha (mesmo is_test) → INVALID_OTP', async () => {
    const { res, repo } = await claimConfirm(fichaDb({ id: OUTRO_ID, isTest: true }), OUTRO_ID);
    expect(res.error).toBe('INVALID_OTP');
    expect(repo.updateImportedWorkerData).toHaveBeenCalledTimes(0);
  });

  function accountLink(ownerIsTest: boolean, ownerId: string) {
    const sender = makeSender();
    const pool = {
      query: jest.fn().mockImplementation((sql: string) => {
        if (sql.includes('WHERE auth_uid')) return Promise.resolve({ rows: [{ id: 'me', email: TEST_TOKEN, auth_uid: 'uid-1', phone: null, updated_at: new Date(), merged_into_id: null }] });
        if (sql.includes('phone = ANY')) return Promise.resolve({ rows: [{ id: ownerId, email: 'o@x.com', auth_uid: 'FirebaseOld', phone: '5491155261243', updated_at: new Date(), is_test: ownerIsTest }] });
        if (sql.includes("event = 'started'")) return Promise.resolve({ rows: [{ cnt: '0' }] });
        if (sql.includes('worker_job_applications')) return Promise.resolve({ rows: [{ high: false }] });
        if (sql.includes('SELECT id, updated_at')) return Promise.resolve({ rows: [] });
        if (sql.includes('rows_reparented')) return Promise.resolve({ rows: [{ rows_reparented: {} }] });
        if (sql.includes('SELECT status FROM workers')) return Promise.resolve({ rows: [{ status: 'REGISTERED' }] });
        return Promise.resolve({ rows: [] });
      }),
    } as unknown as Pool;
    const adminMerge = { execute: jest.fn().mockResolvedValue({ audit_ids: [1], survivor_id: 'me', absorbed_ids: [ownerId] }) };
    const service = new AccountLinkService(pool, {
      otp: new TwilioVerifyOtpAdapter(new IsTestOtpGuardedVerify(sender as never)), adminMerge: adminMerge as never, encryption: { decrypt: jest.fn().mockResolvedValue('') } as never,
    });
    return { service, adminMerge };
  }

  it('T-F3c-23 account-link confirm: ficha dona is_test + mesma ficha aceita e une', async () => {
    const { service, adminMerge } = accountLink(true, WORKER_ID);
    const { verificationSid } = await service.start('uid-1', '1155261243', TEST_TOKEN);
    process.env.E2E_OTP_CODE = STUB_CODE;
    const out = await service.confirm('uid-1', '1155261243', verificationSid, STUB_CODE, TEST_TOKEN);
    expect(out).toMatchObject({ status: 'merged' });
    expect(adminMerge.execute).toHaveBeenCalledTimes(1);
  });

  it('T-F3c-23 account-link confirm: sid de ficha is_test usado contra ficha dona REAL → INVALID_OTP, sem união', async () => {
    const test = accountLink(true, WORKER_ID);
    const { verificationSid } = await test.service.start('uid-1', '1155261243', TEST_TOKEN);
    process.env.E2E_OTP_CODE = STUB_CODE;
    // Mesmo sid lacrado (chave do processo) e MESMO id, mas no banco a ficha dona agora não é de teste.
    const real = accountLink(false, WORKER_ID);
    await expect(real.service.confirm('uid-1', '1155261243', verificationSid, STUB_CODE, TEST_TOKEN))
      .rejects.toMatchObject({ code: 'INVALID_OTP' });
    expect(real.adminMerge.execute).toHaveBeenCalledTimes(0);
  });
});
