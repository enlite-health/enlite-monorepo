import { createOtpChallengePort, dailyMaxFrom } from '../createOtpChallengePort';
import { GuardedOtpChallengePort } from '@modules/auth/application/GuardedOtpChallengePort';
import { PgOtpChallengeService } from '@modules/auth/infrastructure/PgOtpChallengeService';
import { TwilioVerifyOtpAdapter } from '@modules/auth/infrastructure/TwilioVerifyOtpAdapter';

jest.mock('twilio', () => jest.fn(() => ({})));
const mockGetInstance = jest.fn(() => ({ getPool: () => ({ query: jest.fn() }) }));
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => mockGetInstance() },
}));

type Interno = { inner: unknown; adapter: string; dailyMax: number };
const interno = (p: unknown) => p as Interno;

const COMPLETO = {
  TWILIO_AUTH_TEMPLATE_CONTENT_SID: 'HX-teste',
  OTP_HMAC_PEPPER: 'p'.repeat(32),
  TWILIO_ACCOUNT_SID: 'AC-teste',
  TWILIO_AUTH_TOKEN: 'token-teste',
  TWILIO_WHATSAPP_NUMBER: '+5491100000000',
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

  it('no ramo Verify, montar NÃO resolve o pool: sem banco configurado não lança', () => {
    mockGetInstance.mockClear();
    mockGetInstance.mockImplementation(() => { throw new Error('No database configuration found.'); });
    try {
      expect(() => createOtpChallengePort({} as NodeJS.ProcessEnv)).not.toThrow();
      expect(mockGetInstance).not.toHaveBeenCalled();
    } finally {
      mockGetInstance.mockImplementation(() => ({ getPool: () => ({ query: jest.fn() }) }));
    }
  });

  it('em Cloud Run, o teto ausente derruba a montagem', () => {
    expect(() => createOtpChallengePort({ K_SERVICE: 'worker-functions' } as NodeJS.ProcessEnv)).toThrow('OTP_GLOBAL_DAILY_MAX');
  });
});

describe('createOtpChallengePort — conjunto do OTP próprio validado no boot (B5)', () => {
  const montar = (e: Record<string, string | undefined>) => () => createOtpChallengePort({ ...e } as NodeJS.ProcessEnv);

  it('ContentSid + pepper de 31: lança citando OTP_HMAC_PEPPER', () => {
    expect(montar({ ...COMPLETO, OTP_HMAC_PEPPER: 'p'.repeat(31) })).toThrow('OTP_HMAC_PEPPER');
  });

  it('ContentSid sem número nem messaging service: lança', () => {
    expect(montar({ ...COMPLETO, TWILIO_WHATSAPP_NUMBER: undefined })).toThrow('TWILIO_WHATSAPP_NUMBER');
  });

  it('ContentSid sem pepper: lança (antes caía em Verify silencioso)', () => {
    expect(montar({ ...COMPLETO, OTP_HMAC_PEPPER: undefined })).toThrow('misconfigured');
  });

  it('só o messaging service basta no lugar do número', () => {
    const port = montar({ ...COMPLETO, TWILIO_WHATSAPP_NUMBER: undefined, TWILIO_MESSAGING_SERVICE_SID: 'MG-teste' })();
    expect(interno(port).adapter).toBe('own');
  });

  it('a mensagem de erro não contém valor de env', () => {
    const marcado = { ...COMPLETO, TWILIO_AUTH_TOKEN: 'VALOR-MARCADO-TOKEN', TWILIO_ACCOUNT_SID: 'VALOR-MARCADO-AC',
      TWILIO_AUTH_TEMPLATE_CONTENT_SID: 'VALOR-MARCADO-HX', OTP_HMAC_PEPPER: 'VALOR-MARCADO-PEPPER', TWILIO_WHATSAPP_NUMBER: undefined };
    let msg = '';
    try { montar(marcado)(); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain('misconfigured');
    expect(msg).not.toContain('VALOR-MARCADO');
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
