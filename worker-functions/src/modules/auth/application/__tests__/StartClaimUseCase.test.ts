import { TwilioVerifyOtpAdapter } from '../../infrastructure/TwilioVerifyOtpAdapter';
import { StartClaimUseCase } from '../StartClaimUseCase';
import { Result } from '@shared/utils/Result';
import { Worker } from '@modules/worker/domain/Worker';
import { logger } from '@shared/logging';

// Mock logger para não poluir output
jest.mock('@shared/logging', () => ({
  logger: {
    child: jest.fn().mockReturnValue({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }),
  },
  reportError: jest.fn(),
  safeErrorFields: (e: unknown) => ({ errorName: e instanceof Error ? e.name : typeof e, code: (e as { code?: string } | null)?.code ?? null }),
}));

const WORKER_ID = 'a1b2c3d4-1234-4abc-8def-9876543210ab';
const FICHA_PHONE = '+5491155261243';

const importedWorker: Worker = {
  id: WORKER_ID,
  authUid: 'anacareimport_+5411999887766',
  email: 'importado@anacareimport.invalid',
  phone: FICHA_PHONE,
  currentStep: 1,
  status: 'INCOMPLETE_REGISTER',
  country: 'AR',
  timezone: 'America/Argentina/Buenos_Aires',
  registrationCompleted: false,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
};

const makeRepo = (overrides = {}) => ({
  hasAbsorbedRealLogin: jest.fn().mockResolvedValue(Result.ok(false)),
  findByAuthUid: jest.fn().mockResolvedValue(Result.ok(null)),
  findByEmail: jest.fn().mockResolvedValue(Result.ok(null)),
  findByPhoneCandidates: jest.fn().mockResolvedValue(Result.ok(null)),
  findById: jest.fn(),
  create: jest.fn(),
  updateAuthUid: jest.fn(),
  updateImportedWorkerData: jest.fn(),
  updatePersonalInfo: jest.fn(),
  findByPhone: jest.fn(),
  updateStep: jest.fn(),
  delete: jest.fn(),
  deleteByAuthUid: jest.fn(),
  ...overrides,
});

const makeTwilio = (overrides = {}) => ({
  startVerification: jest.fn().mockResolvedValue({ verificationSid: 'VE_MOCK_SID' }),
  checkVerification: jest.fn(),
  ...overrides,
});

describe('StartClaimUseCase', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('candidato encontrado', () => {
    it('retorna candidateWorkerId, phoneMasked e verificationSid', async () => {
      const repo = makeRepo({
        findByPhoneCandidates: jest.fn().mockResolvedValue(Result.ok(importedWorker)),
      });
      const twilio = makeTwilio();
      const useCase = new StartClaimUseCase(repo as any, new TwilioVerifyOtpAdapter(twilio as any));

      const result = await useCase.execute({
        authUid: 'newUid123',
        email: 'joana@gmail.com',
        phone: '+5491155261243',
      });

      expect(result.isSuccess).toBe(true);
      const output = result.getValue();
      expect('noCandidate' in output).toBe(false);
      if (!('noCandidate' in output)) {
        expect(output).toEqual({ phoneMasked: expect.any(String), verificationSid: 'VE_MOCK_SID' });
        expect(output.verificationSid).toBe('VE_MOCK_SID');
        expect(output.phoneMasked).toMatch(/\*{4}/);
      }
    });

    it('dispara OTP para o phone DA FICHA, não o do payload (anti-hijack)', async () => {
      const repo = makeRepo({
        findByPhoneCandidates: jest.fn().mockResolvedValue(Result.ok(importedWorker)),
      });
      const twilio = makeTwilio();
      const useCase = new StartClaimUseCase(repo as any, new TwilioVerifyOtpAdapter(twilio as any));

      await useCase.execute({
        authUid: 'newUid',
        email: 'outro@gmail.com',
        phone: '+5491166667777', // phone diferente do da ficha
      });

      expect(twilio.startVerification).toHaveBeenCalledWith(FICHA_PHONE, expect.objectContaining({ fichaIsTest: false }));
    });

    it('retorna fail quando Twilio lança erro', async () => {
      const repo = makeRepo({
        findByPhoneCandidates: jest.fn().mockResolvedValue(Result.ok(importedWorker)),
      });
      const twilio = makeTwilio({
        startVerification: jest.fn().mockRejectedValue(new Error('Network error')),
      });
      const useCase = new StartClaimUseCase(repo as any, new TwilioVerifyOtpAdapter(twilio as any));

      const result = await useCase.execute({
        authUid: 'newUid',
        email: 'joana@gmail.com',
        phone: '+5491155261243',
      });

      expect(result.isFailure).toBe(true);
      expect(result.error).toBe('OTP_START_FAILED');
    });

    it('loga claim_start_otp_dispatched quando Twilio responde sucesso', async () => {
      const logChild = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
      (logger.child as jest.Mock).mockReturnValue(logChild);

      const repo = makeRepo({
        findByPhoneCandidates: jest.fn().mockResolvedValue(Result.ok(importedWorker)),
      });
      const twilio = makeTwilio();
      const useCase = new StartClaimUseCase(repo as any, new TwilioVerifyOtpAdapter(twilio as any));

      await useCase.execute({
        authUid: 'newUid',
        email: 'joana@gmail.com',
        phone: FICHA_PHONE,
      });

      expect(logChild.info).toHaveBeenCalledWith(
        expect.objectContaining({ msg: 'claim_start_otp_dispatched' }),
      );
    });

    it('loga claim_start_twilio_failed quando Twilio falha', async () => {
      const logChild = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
      (logger.child as jest.Mock).mockReturnValue(logChild);

      const repo = makeRepo({
        findByPhoneCandidates: jest.fn().mockResolvedValue(Result.ok(importedWorker)),
      });
      const twilio = makeTwilio({
        startVerification: jest.fn().mockRejectedValue(new Error('Twilio unavailable')),
      });
      const useCase = new StartClaimUseCase(repo as any, new TwilioVerifyOtpAdapter(twilio as any));

      await useCase.execute({
        authUid: 'newUid',
        email: 'joana@gmail.com',
        phone: FICHA_PHONE,
      });

      expect(logChild.error).toHaveBeenCalledWith(
        expect.objectContaining({ msg: 'claim_start_twilio_failed' }),
      );
    });
  });

  describe('nenhum candidato', () => {
    it('retorna { noCandidate: true } quando não encontra ficha por phone', async () => {
      const repo = makeRepo({
        findByPhoneCandidates: jest.fn().mockResolvedValue(Result.ok(null)),
      });
      const twilio = makeTwilio();
      const useCase = new StartClaimUseCase(repo as any, new TwilioVerifyOtpAdapter(twilio as any));

      const result = await useCase.execute({
        authUid: 'newUid',
        email: 'joana@gmail.com',
        phone: '+5491199990000',
      });

      expect(result.isSuccess).toBe(true);
      const output = result.getValue();
      expect('noCandidate' in output && output.noCandidate).toBe(true);
      expect(twilio.startVerification).not.toHaveBeenCalled();
    });

    it('retorna { noCandidate: true } quando ficha encontrada não é importada (authUid real)', async () => {
      const realWorker: Worker = {
        ...importedWorker,
        authUid: 'realFirebaseUid999',
      };
      const repo = makeRepo({
        findByPhoneCandidates: jest.fn().mockResolvedValue(Result.ok(realWorker)),
      });
      const twilio = makeTwilio();
      const useCase = new StartClaimUseCase(repo as any, new TwilioVerifyOtpAdapter(twilio as any));

      const result = await useCase.execute({
        authUid: 'newUid',
        email: 'joana@gmail.com',
        phone: '+5491155261243',
      });

      expect(result.isSuccess).toBe(true);
      const output = result.getValue();
      expect('noCandidate' in output && output.noCandidate).toBe(true);
    });

    it('P5: sobrevivente sintética que absorveu login real NÃO é candidata (sem OTP)', async () => {
      const repo = makeRepo({
        findByPhoneCandidates: jest.fn().mockResolvedValue(Result.ok(importedWorker)),
        hasAbsorbedRealLogin: jest.fn().mockResolvedValue(Result.ok(true)),
      });
      const twilio = makeTwilio();
      const useCase = new StartClaimUseCase(repo as any, new TwilioVerifyOtpAdapter(twilio as any));

      const result = await useCase.execute({ authUid: 'newUid', email: 'joana@gmail.com', phone: '+5491155261243' });

      expect(repo.hasAbsorbedRealLogin).toHaveBeenCalledWith(WORKER_ID);
      expect(result.isSuccess).toBe(true);
      const output = result.getValue();
      expect('noCandidate' in output && output.noCandidate).toBe(true);
      expect(twilio.startVerification).not.toHaveBeenCalled();
    });

    it('controle positivo: ficha sintética comum (nada absorvido) continua candidata', async () => {
      const repo = makeRepo({
        findByPhoneCandidates: jest.fn().mockResolvedValue(Result.ok(importedWorker)),
      });
      const twilio = makeTwilio();
      const useCase = new StartClaimUseCase(repo as any, new TwilioVerifyOtpAdapter(twilio as any));

      const result = await useCase.execute({ authUid: 'newUid', email: 'joana@gmail.com', phone: '+5491155261243' });

      expect(repo.hasAbsorbedRealLogin).toHaveBeenCalledWith(WORKER_ID);
      expect('noCandidate' in result.getValue()).toBe(false);
      expect(twilio.startVerification).toHaveBeenCalledTimes(1);
    });

    it('falha ao consultar o repositório vira falha (nunca candidata por omissão)', async () => {
      const repo = makeRepo({
        findByPhoneCandidates: jest.fn().mockResolvedValue(Result.ok(importedWorker)),
        hasAbsorbedRealLogin: jest.fn().mockResolvedValue(Result.fail('db down')),
      });
      const twilio = makeTwilio();
      const useCase = new StartClaimUseCase(repo as any, new TwilioVerifyOtpAdapter(twilio as any));

      const result = await useCase.execute({ authUid: 'newUid', email: 'joana@gmail.com', phone: '+5491155261243' });

      expect(result.isFailure).toBe(true);
      expect(twilio.startVerification).not.toHaveBeenCalled();
    });

    it('loga claim_start_no_candidate quando não encontra ficha', async () => {
      const logChild = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
      (logger.child as jest.Mock).mockReturnValue(logChild);

      const repo = makeRepo({
        findByPhoneCandidates: jest.fn().mockResolvedValue(Result.ok(null)),
      });
      const twilio = makeTwilio();
      const useCase = new StartClaimUseCase(repo as any, new TwilioVerifyOtpAdapter(twilio as any));

      await useCase.execute({
        authUid: 'newUid',
        email: 'joana@gmail.com',
        phone: '+5491199990000',
      });

      expect(logChild.info).toHaveBeenCalledWith(
        expect.objectContaining({ msg: 'claim_start_no_candidate' }),
      );
    });
  });

  describe('validação de phone', () => {
    it('retorna INVALID_PHONE para número com menos de 10 dígitos', async () => {
      const repo = makeRepo();
      const twilio = makeTwilio();
      const useCase = new StartClaimUseCase(repo as any, new TwilioVerifyOtpAdapter(twilio as any));

      const result = await useCase.execute({
        authUid: 'newUid',
        email: 'joana@gmail.com',
        phone: '12345',
      });

      expect(result.isFailure).toBe(true);
      expect(result.error).toBe('INVALID_PHONE');
      expect(repo.findByPhoneCandidates).not.toHaveBeenCalled();
    });
  });

  describe('erros do repositório', () => {
    it('propaga erro do repositório', async () => {
      const repo = makeRepo({
        findByPhoneCandidates: jest.fn().mockResolvedValue(
          Result.fail('DB connection lost')
        ),
      });
      const twilio = makeTwilio();
      const useCase = new StartClaimUseCase(repo as any, new TwilioVerifyOtpAdapter(twilio as any));

      const result = await useCase.execute({
        authUid: 'newUid',
        email: 'joana@gmail.com',
        phone: '+5491155261243',
      });

      expect(result.isFailure).toBe(true);
      expect(result.error).toBe('DB connection lost');
    });
  });

  describe('todos os prefixes importados reconhecidos', () => {
    it.each([
      'anacareimport_abc',
      'candidatoimport_abc',
      'pretalnimport_abc',
      'base1import_abc',
      'clickup_encuadre_abc',
    ])('reconhece como importado: %s', async (authUid) => {
      const worker: Worker = { ...importedWorker, authUid };
      const repo = makeRepo({
        findByPhoneCandidates: jest.fn().mockResolvedValue(Result.ok(worker)),
      });
      const twilio = makeTwilio();
      const useCase = new StartClaimUseCase(repo as any, new TwilioVerifyOtpAdapter(twilio as any));

      const result = await useCase.execute({
        authUid: 'newUid',
        email: 'joana@gmail.com',
        phone: '+5491155261243',
      });

      expect(result.isSuccess).toBe(true);
      expect('noCandidate' in result.getValue()).toBe(false);
    });
  });

  describe('G1, B8 e requesterUid', () => {
    const otpDuble = (start: jest.Mock) => ({ start, check: jest.fn(), cancel: jest.fn() });
    const repoComFicha = () => makeRepo({ findByPhoneCandidates: jest.fn().mockResolvedValue(Result.ok(importedWorker)) });

    it('telefone de outro país: PHONE_COUNTRY_NOT_SUPPORTED, sem consultar o banco nem enviar', async () => {
      const repo = repoComFicha();
      const start = jest.fn();
      const r = await new StartClaimUseCase(repo as any, otpDuble(start) as any).execute({
        authUid: 'uid-teste-1', email: 'joana@gmail.com', phone: '+12025550123',
      });
      expect(r.error).toBe('PHONE_COUNTRY_NOT_SUPPORTED');
      expect(repo.findByPhoneCandidates).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
    });

    it('requesterUid = authUid do token no otp.start', async () => {
      const start = jest.fn().mockResolvedValue({ challengeId: 'ch-1' });
      await new StartClaimUseCase(repoComFicha() as any, otpDuble(start) as any).execute({
        authUid: 'uid-teste-1', email: 'joana@gmail.com', phone: '+5491155261243',
      });
      expect(start).toHaveBeenCalledWith(expect.objectContaining({ requesterUid: 'uid-teste-1' }));
    });

    it('B8: falha genérica com telefone na mensagem vira OTP_START_FAILED e o log não tem o telefone', async () => {
      const logChild = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
      (logger.child as jest.Mock).mockReturnValue(logChild);
      const start = jest.fn().mockRejectedValue(Object.assign(new Error('Invalid To +5491100000000'), { code: 21211 }));
      const r = await new StartClaimUseCase(repoComFicha() as any, otpDuble(start) as any).execute({
        authUid: 'uid-teste-1', email: 'joana@gmail.com', phone: '+5491155261243',
      });
      expect(r.error).toBe('OTP_START_FAILED');
      expect(JSON.stringify(logChild.error.mock.calls)).not.toContain('5491100000000');
      expect(logChild.error).toHaveBeenCalledWith(expect.objectContaining({ msg: 'claim_start_twilio_failed', errorName: 'Error' }));
    });

    it.each(['RATE_LIMITED', 'OTP_CHANNEL_UNAVAILABLE', 'PHONE_COUNTRY_NOT_SUPPORTED'])('recusa %s do port passa como está', async (code) => {
      const start = jest.fn().mockRejectedValue(new Error(code));
      const r = await new StartClaimUseCase(repoComFicha() as any, otpDuble(start) as any).execute({
        authUid: 'uid-teste-1', email: 'joana@gmail.com', phone: '+5491155261243',
      });
      expect(r.error).toBe(code);
    });
  });
});
