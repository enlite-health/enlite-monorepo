import { createOtpChallengePort, dailyMaxFrom } from '../createOtpChallengePort';
import { GuardedOtpChallengePort } from '@modules/auth/application/GuardedOtpChallengePort';
import { PgOtpChallengeService } from '@modules/auth/infrastructure/PgOtpChallengeService';
import { TwilioVerifyOtpAdapter } from '@modules/auth/infrastructure/TwilioVerifyOtpAdapter';

jest.mock('twilio', () => jest.fn(() => ({})));
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: jest.fn() }) }) },
}));

type Interno = { inner: unknown; adapter: string; dailyMax: number };
const interno = (p: unknown) => p as Interno;

const COMPLETO = {
  TWILIO_AUTH_TEMPLATE_CONTENT_SID: 'HX-teste',
  OTP_HMAC_PEPPER: 'pepper-teste',
  TWILIO_ACCOUNT_SID: 'AC-teste',
  TWILIO_AUTH_TOKEN: 'token-teste',
};

describe('createOtpChallengePort — decorator em volta dos dois adapters', () => {
  it('sem ContentSid: GuardedOtpChallengePort com o adapter verify', () => {
    const port = createOtpChallengePort({} as NodeJS.ProcessEnv);
    expect(port).toBeInstanceOf(GuardedOtpChallengePort);
    expect(interno(port).adapter).toBe('verify');
    expect(interno(port).inner).toBeInstanceOf(TwilioVerifyOtpAdapter);
  });

  it('com o conjunto completo: GuardedOtpChallengePort com o adapter own', () => {
    const port = createOtpChallengePort({ ...COMPLETO, OTP_GLOBAL_DAILY_MAX: '99' } as NodeJS.ProcessEnv);
    expect(port).toBeInstanceOf(GuardedOtpChallengePort);
    expect(interno(port).adapter).toBe('own');
    expect(interno(port).inner).toBeInstanceOf(PgOtpChallengeService);
    expect(interno(port).dailyMax).toBe(99);
  });

  it('em Cloud Run, o teto ausente derruba a montagem', () => {
    expect(() => createOtpChallengePort({ K_SERVICE: 'worker-functions' } as NodeJS.ProcessEnv)).toThrow('OTP_GLOBAL_DAILY_MAX');
  });
});

describe('dailyMaxFrom', () => {
  it('valor válido vale em qualquer ambiente', () => {
    expect(dailyMaxFrom({ OTP_GLOBAL_DAILY_MAX: '99' } as NodeJS.ProcessEnv)).toBe(99);
    expect(dailyMaxFrom({ OTP_GLOBAL_DAILY_MAX: '99', K_SERVICE: 'x' } as NodeJS.ProcessEnv)).toBe(99);
  });

  it('sem K_SERVICE e sem env: 1000', () => {
    expect(dailyMaxFrom({} as NodeJS.ProcessEnv)).toBe(1000);
  });

  it.each([[undefined], ['0'], ['-1'], ['abc'], ['1.5'], ['']])('com K_SERVICE e valor %p: lança', (v) => {
    expect(() => dailyMaxFrom({ K_SERVICE: 'worker-functions', OTP_GLOBAL_DAILY_MAX: v } as NodeJS.ProcessEnv)).toThrow(
      'OTP_GLOBAL_DAILY_MAX must be a positive integer',
    );
  });
});
