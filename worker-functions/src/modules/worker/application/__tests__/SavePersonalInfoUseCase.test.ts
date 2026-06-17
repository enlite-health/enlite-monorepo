import { SavePersonalInfoUseCase } from '../SavePersonalInfoUseCase';
import { Result } from '@shared/utils/Result';

const mockWorker = {
  id: 'worker-123',
  authUid: 'auth-123',
  email: 'test@example.com',
  currentStep: 1,
  status: 'INCOMPLETE_REGISTER',
  country: 'AR',
  timezone: 'UTC',
  registrationCompleted: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockUpdatedWorker = {
  ...mockWorker,
  firstNameEncrypted: 'enc-firstName',
  lastNameEncrypted: 'enc-lastName',
  profession: 'CAREGIVER',
};

const makeRepository = (overrides = {}) => ({
  findById: jest.fn().mockResolvedValue(Result.ok(mockWorker)),
  updatePersonalInfo: jest.fn().mockResolvedValue(Result.ok(mockUpdatedWorker)),
  updateStep: jest.fn().mockResolvedValue(Result.ok({ ...mockWorker, currentStep: 3 })),
  findByAuthUid: jest.fn(),
  findByEmail: jest.fn(),
  create: jest.fn(),
  updateStatus: jest.fn(),
  updateAuthUid: jest.fn(),
  findByPhone: jest.fn(),
  findByPhoneCandidates: jest.fn().mockResolvedValue(Result.ok(null)),
  delete: jest.fn(),
  deleteByAuthUid: jest.fn(),
  recalculateStatus: jest.fn().mockResolvedValue(null),
  ...overrides,
});

const personalInfoPayload = {
  workerId: 'worker-123',
  firstName: 'Gabriel',
  lastName: 'Stein',
  sex: 'male',
  gender: 'male',
  birthDate: '1990-04-18',
  documentType: 'DNI',
  documentNumber: '12345678',
  phone: '+5411999999',
  languages: ['pt', 'es'],
  profession: 'CAREGIVER',
  knowledgeLevel: 'SECONDARY',
  titleCertificate: 'Cert XYZ',
  experienceTypes: ['adicciones'],
  yearsExperience: '3_5',
  preferredTypes: ['adicciones'],
  preferredAgeRange: ['adolescents'],
  termsAccepted: true,
  privacyAccepted: true,
};

describe('SavePersonalInfoUseCase', () => {
  describe('sucesso', () => {
    it('deve salvar informações pessoais e retornar o worker atualizado', async () => {
      const repo = makeRepository();
      const useCase = new SavePersonalInfoUseCase(repo as any);

      const result = await useCase.execute(personalInfoPayload);

      expect(result.isFailure).toBe(false);
      expect(repo.findById).toHaveBeenCalledWith('worker-123');
      expect(repo.updatePersonalInfo).toHaveBeenCalledWith(
        expect.objectContaining({
          workerId: 'worker-123',
          firstName: 'Gabriel',
          lastName: 'Stein',
          profession: 'CAREGIVER',
        })
      );
    });

    it('NÃO deve chamar updateStep — sem avanço de step na edição por abas', async () => {
      const repo = makeRepository();
      const useCase = new SavePersonalInfoUseCase(repo as any);

      await useCase.execute(personalInfoPayload);

      expect(repo.updateStep).not.toHaveBeenCalled();
    });

    it('deve aceitar profilePhotoUrl opcional', async () => {
      const repo = makeRepository();
      const useCase = new SavePersonalInfoUseCase(repo as any);

      const result = await useCase.execute({
        ...personalInfoPayload,
        profilePhotoUrl: 'https://example.com/photo.jpg',
      });

      expect(result.isFailure).toBe(false);
      expect(repo.updatePersonalInfo).toHaveBeenCalledWith(
        expect.objectContaining({ profilePhotoUrl: 'https://example.com/photo.jpg' })
      );
    });

    it('deve funcionar sem profilePhotoUrl', async () => {
      const repo = makeRepository();
      const useCase = new SavePersonalInfoUseCase(repo as any);

      const result = await useCase.execute(personalInfoPayload);

      expect(result.isFailure).toBe(false);
    });
  });

  describe('worker não encontrado', () => {
    it('deve falhar se worker não existe', async () => {
      const repo = makeRepository({
        findById: jest.fn().mockResolvedValue(Result.ok(null)),
      });
      const useCase = new SavePersonalInfoUseCase(repo as any);

      const result = await useCase.execute(personalInfoPayload);

      expect(result.isFailure).toBe(true);
      expect(result.error).toBe('Worker not found');
      expect(repo.updatePersonalInfo).not.toHaveBeenCalled();
    });

    it('deve falhar se findById retorna erro', async () => {
      const repo = makeRepository({
        findById: jest.fn().mockResolvedValue(Result.fail('DB connection error')),
      });
      const useCase = new SavePersonalInfoUseCase(repo as any);

      const result = await useCase.execute(personalInfoPayload);

      expect(result.isFailure).toBe(true);
      expect(result.error).toBe('DB connection error');
    });
  });

  describe('falha no updatePersonalInfo', () => {
    it('deve propagar erro do repositório', async () => {
      const repo = makeRepository({
        updatePersonalInfo: jest.fn().mockResolvedValue(
          Result.fail('Failed to update personal info: Failed to encrypt data')
        ),
      });
      const useCase = new SavePersonalInfoUseCase(repo as any);

      const result = await useCase.execute(personalInfoPayload);

      expect(result.isFailure).toBe(true);
      expect(result.error).toContain('Failed to encrypt data');
      expect(repo.updateStep).not.toHaveBeenCalled();
    });
  });

  describe('telefone — normalização e colisão', () => {
    it('grava o telefone NORMALIZADO (canônico) quando há troca para número livre', async () => {
      // worker sem phone atual + número livre → grava canônico.
      const repo = makeRepository();
      const useCase = new SavePersonalInfoUseCase(repo as any);

      // '1151265663' (10 díg) → '5491151265663'
      await useCase.execute({ ...personalInfoPayload, phone: '1151265663' });

      expect(repo.findByPhoneCandidates).toHaveBeenCalled();
      expect(repo.updatePersonalInfo).toHaveBeenCalledWith(
        expect.objectContaining({ phone: '5491151265663' }),
      );
    });

    it('NÃO altera o telefone (passa vazio) quando o número não mudou, mesmo em formato diferente', async () => {
      // worker já tem '1151265663'; reenvio em formato canônico = mesmo número.
      const repo = makeRepository({
        findById: jest.fn().mockResolvedValue(Result.ok({ ...mockWorker, phone: '1151265663' })),
      });
      const useCase = new SavePersonalInfoUseCase(repo as any);

      await useCase.execute({ ...personalInfoPayload, phone: '+5491151265663' });

      // phone vazio → repo mantém o atual via COALESCE; não checa colisão.
      expect(repo.findByPhoneCandidates).not.toHaveBeenCalled();
      expect(repo.updatePersonalInfo).toHaveBeenCalledWith(
        expect.objectContaining({ phone: '' }),
      );
    });

    it('falha com PHONE_NOT_AVAILABLE quando o número pertence a OUTRO worker', async () => {
      const repo = makeRepository({
        findById: jest.fn().mockResolvedValue(Result.ok({ ...mockWorker, phone: '1100000000' })),
        findByPhoneCandidates: jest
          .fn()
          .mockResolvedValue(Result.ok({ ...mockWorker, id: 'outro-worker-999' })),
      });
      const useCase = new SavePersonalInfoUseCase(repo as any);

      const result = await useCase.execute({ ...personalInfoPayload, phone: '1151265663' });

      expect(result.isFailure).toBe(true);
      expect(result.error).toBe('PHONE_NOT_AVAILABLE');
      expect(repo.updatePersonalInfo).not.toHaveBeenCalled();
    });

    it('NÃO bloqueia quando o número "de outro" é na verdade o próprio worker', async () => {
      const repo = makeRepository({
        findById: jest.fn().mockResolvedValue(Result.ok({ ...mockWorker, phone: '1100000000' })),
        findByPhoneCandidates: jest
          .fn()
          .mockResolvedValue(Result.ok({ ...mockWorker, id: 'worker-123' })),
      });
      const useCase = new SavePersonalInfoUseCase(repo as any);

      const result = await useCase.execute({ ...personalInfoPayload, phone: '1151265663' });

      expect(result.isFailure).toBe(false);
      expect(repo.updatePersonalInfo).toHaveBeenCalledWith(
        expect.objectContaining({ phone: '5491151265663' }),
      );
    });
  });
});
