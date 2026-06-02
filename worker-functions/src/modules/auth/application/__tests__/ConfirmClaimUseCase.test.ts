import { ConfirmClaimUseCase } from '../ConfirmClaimUseCase';
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
}));

const CANDIDATE_ID = 'a1b2c3d4-1234-4abc-8def-9876543210ab';
const NEW_AUTH_UID = 'newFirebaseUid999';
const NEW_EMAIL = 'joana@gmail.com';
const VERIFICATION_SID = 'VE_TEST_SID';

const importedWorker: Worker = {
  id: CANDIDATE_ID,
  authUid: 'anacareimport_+5411999887766',
  email: 'importado@anacareimport.invalid',
  phone: '+5491155261243',
  currentStep: 1,
  status: 'INCOMPLETE_REGISTER',
  country: 'AR',
  timezone: 'America/Argentina/Buenos_Aires',
  registrationCompleted: false,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
};

const claimedWorker: Worker = {
  ...importedWorker,
  authUid: NEW_AUTH_UID,
  email: NEW_EMAIL,
};

const makeRepo = (overrides = {}) => ({
  findById: jest.fn().mockResolvedValue(Result.ok(importedWorker)),
  updateImportedWorkerData: jest.fn().mockResolvedValue(Result.ok(claimedWorker)),
  findByAuthUid: jest.fn(),
  findByEmail: jest.fn(),
  findByPhoneCandidates: jest.fn(),
  findByPhone: jest.fn(),
  create: jest.fn(),
  updateAuthUid: jest.fn(),
  updatePersonalInfo: jest.fn(),
  delete: jest.fn(),
  deleteByAuthUid: jest.fn(),
  ...overrides,
});

const makeTwilio = (overrides = {}) => ({
  startVerification: jest.fn(),
  checkVerification: jest.fn().mockResolvedValue({ valid: true, status: 'approved' }),
  ...overrides,
});

const makeInput = (overrides = {}) => ({
  verificationSid: VERIFICATION_SID,
  otp: '123456',
  authUid: NEW_AUTH_UID,
  email: NEW_EMAIL,
  candidateWorkerId: CANDIDATE_ID,
  ...overrides,
});

describe('ConfirmClaimUseCase', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('happy path — OTP válido', () => {
    it('retorna o worker atualizado após confirmar OTP', async () => {
      const repo = makeRepo();
      const twilio = makeTwilio();
      const useCase = new ConfirmClaimUseCase(repo as any, twilio as any);

      const result = await useCase.execute(makeInput());

      expect(result.isSuccess).toBe(true);
      expect(result.getValue().authUid).toBe(NEW_AUTH_UID);
    });

    it('chama updateImportedWorkerData com authUid, email e consentAt', async () => {
      const repo = makeRepo();
      const twilio = makeTwilio();
      const useCase = new ConfirmClaimUseCase(repo as any, twilio as any);

      await useCase.execute(makeInput());

      expect(repo.updateImportedWorkerData).toHaveBeenCalledWith(
        CANDIDATE_ID,
        expect.objectContaining({
          authUid: NEW_AUTH_UID,
          email: NEW_EMAIL,
          consentAt: expect.any(Date),
        }),
      );
    });

    it('chama checkVerification com verificationSid e otp corretos', async () => {
      const repo = makeRepo();
      const twilio = makeTwilio();
      const useCase = new ConfirmClaimUseCase(repo as any, twilio as any);

      await useCase.execute(makeInput({ otp: '654321' }));

      expect(twilio.checkVerification).toHaveBeenCalledWith(VERIFICATION_SID, '654321');
    });

    it('loga claim_confirm_success no caminho de sucesso', async () => {
      const logChild = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
      (logger.child as jest.Mock).mockReturnValue(logChild);

      const repo = makeRepo();
      const twilio = makeTwilio();
      const useCase = new ConfirmClaimUseCase(repo as any, twilio as any);

      await useCase.execute(makeInput());

      expect(logChild.info).toHaveBeenCalledWith(
        expect.objectContaining({ msg: 'claim_confirm_success' }),
      );
    });
  });

  describe('OTP inválido', () => {
    it('retorna INVALID_OTP quando status é pending (código errado)', async () => {
      const repo = makeRepo();
      const twilio = makeTwilio({
        checkVerification: jest.fn().mockResolvedValue({ valid: false, status: 'pending' }),
      });
      const useCase = new ConfirmClaimUseCase(repo as any, twilio as any);

      const result = await useCase.execute(makeInput());

      expect(result.isFailure).toBe(true);
      expect(result.error).toBe('INVALID_OTP');
      expect(repo.updateImportedWorkerData).not.toHaveBeenCalled();
    });

    it('retorna EXPIRED_OTP quando status é expired', async () => {
      const repo = makeRepo();
      const twilio = makeTwilio({
        checkVerification: jest.fn().mockResolvedValue({ valid: false, status: 'expired' }),
      });
      const useCase = new ConfirmClaimUseCase(repo as any, twilio as any);

      const result = await useCase.execute(makeInput());

      expect(result.isFailure).toBe(true);
      expect(result.error).toBe('EXPIRED_OTP');
    });

    it('retorna EXPIRED_OTP quando status é canceled', async () => {
      const repo = makeRepo();
      const twilio = makeTwilio({
        checkVerification: jest.fn().mockResolvedValue({ valid: false, status: 'canceled' }),
      });
      const useCase = new ConfirmClaimUseCase(repo as any, twilio as any);

      const result = await useCase.execute(makeInput());

      expect(result.isFailure).toBe(true);
      expect(result.error).toBe('EXPIRED_OTP');
    });

    it('loga claim_confirm_otp_invalid quando código é errado', async () => {
      const logChild = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
      (logger.child as jest.Mock).mockReturnValue(logChild);

      const repo = makeRepo();
      const twilio = makeTwilio({
        checkVerification: jest.fn().mockResolvedValue({ valid: false, status: 'pending' }),
      });
      const useCase = new ConfirmClaimUseCase(repo as any, twilio as any);

      await useCase.execute(makeInput());

      expect(logChild.warn).toHaveBeenCalledWith(
        expect.objectContaining({ msg: 'claim_confirm_otp_invalid' }),
      );
    });

    it('loga claim_confirm_otp_expired quando verification expirou', async () => {
      const logChild = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
      (logger.child as jest.Mock).mockReturnValue(logChild);

      const repo = makeRepo();
      const twilio = makeTwilio({
        checkVerification: jest.fn().mockResolvedValue({ valid: false, status: 'expired' }),
      });
      const useCase = new ConfirmClaimUseCase(repo as any, twilio as any);

      await useCase.execute(makeInput());

      expect(logChild.warn).toHaveBeenCalledWith(
        expect.objectContaining({ msg: 'claim_confirm_otp_expired' }),
      );
    });
  });

  describe('proteção contra race condition', () => {
    it('retorna NOT_IMPORTABLE quando ficha já foi reivindicada em paralelo', async () => {
      const alreadyClaimedWorker: Worker = {
        ...importedWorker,
        authUid: 'anotherRealUidAlreadyClaimed',
      };
      const repo = makeRepo({
        findById: jest.fn().mockResolvedValue(Result.ok(alreadyClaimedWorker)),
      });
      const twilio = makeTwilio();
      const useCase = new ConfirmClaimUseCase(repo as any, twilio as any);

      const result = await useCase.execute(makeInput());

      expect(result.isFailure).toBe(true);
      expect(result.error).toBe('NOT_IMPORTABLE');
      expect(repo.updateImportedWorkerData).not.toHaveBeenCalled();
    });

    it('loga claim_confirm_candidate_not_importable_anymore na race condition', async () => {
      const logChild = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
      (logger.child as jest.Mock).mockReturnValue(logChild);

      const alreadyClaimedWorker: Worker = {
        ...importedWorker,
        authUid: 'anotherRealUidAlreadyClaimed',
      };
      const repo = makeRepo({
        findById: jest.fn().mockResolvedValue(Result.ok(alreadyClaimedWorker)),
      });
      const twilio = makeTwilio();
      const useCase = new ConfirmClaimUseCase(repo as any, twilio as any);

      await useCase.execute(makeInput());

      expect(logChild.warn).toHaveBeenCalledWith(
        expect.objectContaining({ msg: 'claim_confirm_candidate_not_importable_anymore' }),
      );
    });

    it('retorna CANDIDATE_NOT_FOUND quando ficha não existe mais no banco', async () => {
      const repo = makeRepo({
        findById: jest.fn().mockResolvedValue(Result.ok(null)),
      });
      const twilio = makeTwilio();
      const useCase = new ConfirmClaimUseCase(repo as any, twilio as any);

      const result = await useCase.execute(makeInput());

      expect(result.isFailure).toBe(true);
      expect(result.error).toBe('CANDIDATE_NOT_FOUND');
    });
  });

  describe('erros de infraestrutura', () => {
    it('propaga erro do Twilio como falha com prefixo TWILIO_ERROR', async () => {
      const repo = makeRepo();
      const twilio = makeTwilio({
        checkVerification: jest.fn().mockRejectedValue(new Error('Service unavailable')),
      });
      const useCase = new ConfirmClaimUseCase(repo as any, twilio as any);

      const result = await useCase.execute(makeInput());

      expect(result.isFailure).toBe(true);
      expect(result.error).toContain('TWILIO_ERROR');
    });

    it('propaga erro do repositório no findById', async () => {
      const repo = makeRepo({
        findById: jest.fn().mockResolvedValue(Result.fail('DB timeout')),
      });
      const twilio = makeTwilio();
      const useCase = new ConfirmClaimUseCase(repo as any, twilio as any);

      const result = await useCase.execute(makeInput());

      expect(result.isFailure).toBe(true);
      expect(result.error).toBe('DB timeout');
    });

    it('propaga erro do repositório no updateImportedWorkerData', async () => {
      const repo = makeRepo({
        updateImportedWorkerData: jest.fn().mockResolvedValue(
          Result.fail('Constraint violation: duplicate auth_uid')
        ),
      });
      const twilio = makeTwilio();
      const useCase = new ConfirmClaimUseCase(repo as any, twilio as any);

      const result = await useCase.execute(makeInput());

      expect(result.isFailure).toBe(true);
      expect(result.error).toBe('Constraint violation: duplicate auth_uid');
    });
  });
});
