/**
 * T-F3c-140 — a guarda `is_test` do PR-INF-37 cobre a finalidade NOVA `phone_verify` (AC-11): ficha `is_test` + token `@enlite.test`
 * → o cliente Twilio NÃO é chamado e o código vem do secret; ficha real → é chamado. Cadeia REAL: StartPhoneVerificationUseCase →
 * PgOtpChallengeService → TwilioAuthTemplateSender (guarda), com o cliente Twilio e o pool como dublês (nenhum canal real, sem banco).
 * Morre se a guarda deixar de cobrir `phone_verify`.
 */
import crypto from 'crypto';
import { Result } from '@shared/utils/Result';
import { StartPhoneVerificationUseCase } from '../StartPhoneVerificationUseCase';
import { PgOtpChallengeService } from '../../infrastructure/PgOtpChallengeService';
import { TwilioAuthTemplateSender } from '../../infrastructure/TwilioAuthTemplateSender';

jest.mock('@shared/logging', () => ({
  logger: { child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) },
  reportError: jest.fn(),
  safeErrorFields: () => ({ errorName: 'Error', code: null }),
}));

const PEPPER = 'p'.repeat(40);
const SECRET_CODE = '424242';

function build(ficha: { isTest: boolean }) {
  const inserts: unknown[][] = [];
  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    if (/INSERT INTO otp_challenges/.test(sql)) inserts.push(params ?? []);
    return { rows: [{ phone_win: '0', phone_day: '0', worker_win: '0', worker_day: '0' }], rowCount: 1 };
  });
  const pool = { query, connect: async () => ({ query, release: jest.fn() }) };
  const create = jest.fn().mockResolvedValue({ sid: 'SM_FAKE' });
  const sender = new TwilioAuthTemplateSender({ messages: { create } } as never, { contentSid: 'HXfake', fromNumber: '+5491100000000' });
  const otp = new PgOtpChallengeService(pool as never, sender, () => PEPPER, () => SECRET_CODE);
  const own = { id: 'w-own', authUid: 'uid-own', phone: undefined, isTest: ficha.isTest };
  const workers = {
    findByAuthUid: jest.fn().mockResolvedValue(Result.ok(own)),
    findByPhoneCandidates: jest.fn().mockResolvedValue(Result.ok(null)),
    hasAbsorbedRealLogin: jest.fn().mockResolvedValue(Result.ok(false)),
  };
  const verification = { readState: jest.fn(), markPhoneVerified: jest.fn(), methodFor: jest.fn(), linkProof: jest.fn() };
  return { useCase: new StartPhoneVerificationUseCase(workers as never, verification as never, otp), create, inserts };
}

describe('T-F3c-140 guarda is_test cobre phone_verify', () => {
  it('T-F3c-140 ficha is_test + token @enlite.test: o sender NÃO é chamado e o código é o do secret', async () => {
    const { useCase, create, inserts } = build({ isTest: true });
    const r = await useCase.execute({ authUid: 'uid-own', email: 'qa.signup.run1@enlite.test', phone: '1155550001' });
    expect(r.getValue()).toMatchObject({ status: 'SENT' });
    expect(create).not.toHaveBeenCalled();
    const [challengeId, , purpose, , codeHmac] = inserts[0] as string[];
    expect(purpose).toBe('phone_verify');
    expect(codeHmac).toBe(crypto.createHmac('sha256', PEPPER).update(`${challengeId}|phone_verify|${SECRET_CODE}`).digest('hex'));
  });

  it('T-F3c-140 ficha real: o sender é chamado, com o código de 6 dígitos no template', async () => {
    const { useCase, create } = build({ isTest: false });
    const r = await useCase.execute({ authUid: 'uid-own', email: 'qa.signup.run1@enlite.test', phone: '1155550001' });
    expect(r.getValue()).toMatchObject({ status: 'SENT' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(JSON.parse(create.mock.calls[0][0].contentVariables)['1']).toMatch(/^\d{6}$/);
  });
});
