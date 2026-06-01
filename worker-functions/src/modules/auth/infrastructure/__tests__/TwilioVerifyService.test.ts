/**
 * TwilioVerifyService unit tests — SDK Twilio é mockado via jest.mock.
 */

// Mock do SDK antes de qualquer import do módulo testado
const mockVerificationsCreate = jest.fn();
const mockVerificationChecksCreate = jest.fn();

jest.mock('twilio', () => {
  return jest.fn().mockReturnValue({
    verify: {
      v2: {
        services: jest.fn().mockReturnValue({
          verifications: { create: mockVerificationsCreate },
          verificationChecks: { create: mockVerificationChecksCreate },
        }),
      },
    },
  });
});

// Mock do logger para não poluir output
jest.mock('@shared/logging', () => ({
  logger: {
    child: jest.fn().mockReturnValue({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }),
    warn: jest.fn(),
    info: jest.fn(),
  },
  reportError: jest.fn(),
}));

import { logger } from '@shared/logging';
import { TwilioVerifyService } from '../TwilioVerifyService';

describe('TwilioVerifyService', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...OLD_ENV,
      TWILIO_ACCOUNT_SID: 'ACtest123',
      TWILIO_AUTH_TOKEN: 'test_token',
      TWILIO_VERIFY_SERVICE_SID: 'VAtest456',
    };
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  describe('startVerification', () => {
    it('chama verifications.create com canal sms e retorna verificationSid', async () => {
      mockVerificationsCreate.mockResolvedValue({
        sid: 'VE_RETURNED_SID',
        status: 'pending',
        sendCodeAttempts: [],
        dateUpdated: null,
      });

      const service = new TwilioVerifyService();
      const result = await service.startVerification('+5491155261243');

      expect(result.verificationSid).toBe('VE_RETURNED_SID');
      expect(mockVerificationsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          to: '+5491155261243',
          channel: 'sms',
        }),
      );
    });

    it('lança erro quando SDK Twilio falha', async () => {
      mockVerificationsCreate.mockRejectedValue(new Error('Twilio API error'));

      const service = new TwilioVerifyService();

      await expect(service.startVerification('+5491155261243')).rejects.toThrow(
        'Twilio API error',
      );
    });

    it('lança erro quando serviço não está configurado', async () => {
      process.env.TWILIO_ACCOUNT_SID = '';

      const service = new TwilioVerifyService();

      await expect(service.startVerification('+5491155261243')).rejects.toThrow(
        'TwilioVerifyService not configured',
      );
    });

    it('loga otp_started quando Twilio responde sucesso', async () => {
      const logChild = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
      (logger.child as jest.Mock).mockReturnValue(logChild);

      mockVerificationsCreate.mockResolvedValue({
        sid: 'VE_SID',
        status: 'pending',
        sendCodeAttempts: [],
        dateUpdated: null,
      });

      const service = new TwilioVerifyService();
      await service.startVerification('+5491155261243');

      expect(logChild.info).toHaveBeenCalledWith(
        expect.objectContaining({ msg: 'otp_started' }),
      );
    });

    it('loga otp_start_failed quando SDK Twilio falha', async () => {
      const logChild = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
      (logger.child as jest.Mock).mockReturnValue(logChild);

      mockVerificationsCreate.mockRejectedValue(new Error('Twilio API error'));

      const service = new TwilioVerifyService();
      await expect(service.startVerification('+5491155261243')).rejects.toThrow();

      expect(logChild.error).toHaveBeenCalledWith(
        expect.objectContaining({ msg: 'otp_start_failed' }),
      );
    });
  });

  describe('checkVerification', () => {
    it('retorna valid=true e status=approved para OTP correto', async () => {
      mockVerificationChecksCreate.mockResolvedValue({ status: 'approved' });

      const service = new TwilioVerifyService();
      const result = await service.checkVerification('VE_SID', '123456');

      expect(result.valid).toBe(true);
      expect(result.status).toBe('approved');
      expect(mockVerificationChecksCreate).toHaveBeenCalledWith({
        verificationSid: 'VE_SID',
        code: '123456',
      });
    });

    it('retorna valid=false e status=pending para OTP errado', async () => {
      mockVerificationChecksCreate.mockResolvedValue({ status: 'pending' });

      const service = new TwilioVerifyService();
      const result = await service.checkVerification('VE_SID', '000000');

      expect(result.valid).toBe(false);
      expect(result.status).toBe('pending');
    });

    it('retorna valid=false e status=expired para verificação expirada', async () => {
      mockVerificationChecksCreate.mockResolvedValue({ status: 'expired' });

      const service = new TwilioVerifyService();
      const result = await service.checkVerification('VE_SID', '123456');

      expect(result.valid).toBe(false);
      expect(result.status).toBe('expired');
    });

    it('retorna valid=false e status=canceled para verificação cancelada', async () => {
      mockVerificationChecksCreate.mockResolvedValue({ status: 'canceled' });

      const service = new TwilioVerifyService();
      const result = await service.checkVerification('VE_SID', '123456');

      expect(result.valid).toBe(false);
      expect(result.status).toBe('canceled');
    });

    it('normaliza status desconhecido para canceled', async () => {
      mockVerificationChecksCreate.mockResolvedValue({ status: 'unknown_status' });

      const service = new TwilioVerifyService();
      const result = await service.checkVerification('VE_SID', '123456');

      expect(result.valid).toBe(false);
      expect(result.status).toBe('canceled');
    });

    it('lança erro quando SDK Twilio falha', async () => {
      mockVerificationChecksCreate.mockRejectedValue(new Error('Network timeout'));

      const service = new TwilioVerifyService();

      await expect(service.checkVerification('VE_SID', '123456')).rejects.toThrow(
        'Network timeout',
      );
    });

    it('lança erro quando serviço não está configurado', async () => {
      process.env.TWILIO_VERIFY_SERVICE_SID = '';

      const service = new TwilioVerifyService();

      await expect(service.checkVerification('VE_SID', '123456')).rejects.toThrow(
        'TwilioVerifyService not configured',
      );
    });

    it('loga otp_checked em qualquer resultado', async () => {
      const logChild = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
      (logger.child as jest.Mock).mockReturnValue(logChild);

      mockVerificationChecksCreate.mockResolvedValue({ status: 'approved' });

      const service = new TwilioVerifyService();
      await service.checkVerification('VE_SID', '123456');

      expect(logChild.info).toHaveBeenCalledWith(
        expect.objectContaining({ msg: 'otp_checked' }),
      );
    });

    it('loga otp_check_failed quando SDK Twilio falha', async () => {
      const logChild = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
      (logger.child as jest.Mock).mockReturnValue(logChild);

      mockVerificationChecksCreate.mockRejectedValue(new Error('Network timeout'));

      const service = new TwilioVerifyService();
      await expect(service.checkVerification('VE_SID', '123456')).rejects.toThrow();

      expect(logChild.warn).toHaveBeenCalledWith(
        expect.objectContaining({ msg: 'otp_check_failed' }),
      );
    });
  });

  describe('E2E bypass', () => {
    it('startVerification retorna sid sintético TEST_* sem chamar Twilio quando E2E_OTP_BYPASS=true e K_SERVICE não setada (dev local)', async () => {
      process.env.E2E_OTP_BYPASS = 'true';
      delete process.env.K_SERVICE;

      const service = new TwilioVerifyService();
      const result = await service.startVerification('+5491155261243');

      expect(result.verificationSid).toMatch(/^TEST_[0-9a-f-]{36}$/);
      expect(mockVerificationsCreate).not.toHaveBeenCalled();
    });

    it('checkVerification valida E2E_OTP_CODE quando sid começa com TEST_ e bypass está on', async () => {
      process.env.E2E_OTP_BYPASS = 'true';
      process.env.E2E_OTP_CODE = '654321';
      delete process.env.K_SERVICE;

      const service = new TwilioVerifyService();

      const ok = await service.checkVerification('TEST_abc-123', '654321');
      expect(ok).toEqual({ valid: true, status: 'approved' });

      const bad = await service.checkVerification('TEST_abc-123', '111111');
      expect(bad).toEqual({ valid: false, status: 'pending' });

      expect(mockVerificationChecksCreate).not.toHaveBeenCalled();
    });

    it('checkVerification com sid REAL (VE_*) ignora bypass e vai pro Twilio mesmo se bypass=true', async () => {
      process.env.E2E_OTP_BYPASS = 'true';
      delete process.env.K_SERVICE;

      mockVerificationChecksCreate.mockResolvedValue({ status: 'approved' });

      const service = new TwilioVerifyService();
      const result = await service.checkVerification('VE_REAL_SID', '123456');

      expect(result.valid).toBe(true);
      expect(mockVerificationChecksCreate).toHaveBeenCalled();
    });

    it('bypass é IGNORADO quando K_SERVICE está setada (rodando em Cloud Run) e loga alarme', async () => {
      const errorSpy = jest.fn();
      (logger as unknown as { error: jest.Mock }).error = errorSpy;
      process.env.E2E_OTP_BYPASS = 'true';
      process.env.K_SERVICE = 'worker-functions';
      process.env.K_REVISION = 'worker-functions-00296-d8h';

      mockVerificationsCreate.mockResolvedValue({
        sid: 'VE_REAL',
        status: 'pending',
        sendCodeAttempts: [],
        dateUpdated: null,
      });

      const service = new TwilioVerifyService();
      const result = await service.startVerification('+5491155261243');

      expect(result.verificationSid).toBe('VE_REAL');
      expect(mockVerificationsCreate).toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ msg: 'otp_bypass_leaked_to_production' }),
      );
    });

    it('bypass FUNCIONA mesmo com GCP_PROJECT_ID=enlite-prd, desde que K_SERVICE não esteja setada (dev local apontando pra Firebase prod)', async () => {
      process.env.E2E_OTP_BYPASS = 'true';
      process.env.GCP_PROJECT_ID = 'enlite-prd';
      delete process.env.K_SERVICE;

      const service = new TwilioVerifyService();
      const result = await service.startVerification('+5491155261243');

      expect(result.verificationSid).toMatch(/^TEST_/);
      expect(mockVerificationsCreate).not.toHaveBeenCalled();
    });
  });
});
