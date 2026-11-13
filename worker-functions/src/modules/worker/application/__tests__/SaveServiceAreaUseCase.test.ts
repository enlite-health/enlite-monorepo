import { SaveServiceAreaUseCase } from '../SaveServiceAreaUseCase';
import { Result } from '@shared/utils/Result';
import type { ProfileEditAttribution } from '../../domain/profileEditSource';

const mockRecordBatch = jest.fn().mockResolvedValue(undefined);
jest.mock('../../infrastructure/ProfileChangeAuditRepository', () => ({ ProfileChangeAuditRepository: jest.fn().mockImplementation(() => ({ recordBatch: mockRecordBatch })) }));
jest.mock('@shared/database/DatabaseConnection', () => ({ DatabaseConnection: { getInstance: () => ({ getPool: () => ({}) }) } }));
const ATTR: ProfileEditAttribution = { source: 'worker_self', actorUid: 'auth-123' };

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

const mockServiceArea = {
  id: 'sa-1',
  workerId: 'worker-123',
  address: 'Av. Corrientes 1234, Buenos Aires',
  lat: -34.603722,
  lng: -58.381592,
  serviceRadiusKm: 10,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const makeWorkerRepo = (overrides = {}) => ({
  findById: jest.fn().mockResolvedValue(Result.ok(mockWorker)),
  updateStep: jest.fn().mockResolvedValue(Result.ok({ ...mockWorker, currentStep: 4 })),
  findByAuthUid: jest.fn(),
  findByEmail: jest.fn(),
  create: jest.fn(),
  updatePersonalInfo: jest.fn(),
  updateStatus: jest.fn(),
  updateAuthUid: jest.fn(),
  findByPhone: jest.fn(),
  delete: jest.fn(),
  deleteByAuthUid: jest.fn(),
  recalculateStatus: jest.fn().mockResolvedValue(null),
  ...overrides,
});

const makeServiceAreaRepo = (overrides = {}) => ({
  deleteByWorkerId: jest.fn().mockResolvedValue(Result.ok(undefined)),
  create: jest.fn().mockResolvedValue(Result.ok(mockServiceArea)),
  findByWorkerId: jest.fn(),
  ...overrides,
});

const serviceAreaPayload = {
  workerId: 'worker-123',
  address: 'Av. Corrientes 1234, Buenos Aires',
  addressComplement: 'Piso 3',
  serviceRadiusKm: 10,
  lat: -34.603722,
  lng: -58.381592,
};

describe('SaveServiceAreaUseCase', () => {
  describe('sucesso', () => {
    it('deve deletar área anterior e criar nova', async () => {
      const workerRepo = makeWorkerRepo();
      const serviceAreaRepo = makeServiceAreaRepo();
      const useCase = new SaveServiceAreaUseCase(workerRepo as any, serviceAreaRepo as any);

      const result = await useCase.execute(serviceAreaPayload, ATTR);

      expect(result.isFailure).toBe(false);
      expect(serviceAreaRepo.deleteByWorkerId).toHaveBeenCalledWith('worker-123');
      expect(serviceAreaRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          workerId: 'worker-123',
          address: 'Av. Corrientes 1234, Buenos Aires',
          serviceRadiusKm: 10,
          lat: -34.603722,
          lng: -58.381592,
        })
      );
    });

    it('NÃO deve chamar updateStep — sem avanço de step na edição por abas', async () => {
      const workerRepo = makeWorkerRepo();
      const serviceAreaRepo = makeServiceAreaRepo();
      const useCase = new SaveServiceAreaUseCase(workerRepo as any, serviceAreaRepo as any);

      await useCase.execute(serviceAreaPayload, ATTR);

      expect(workerRepo.updateStep).not.toHaveBeenCalled();
    });

    it('deve retornar o worker original (não o de updateStep)', async () => {
      const workerRepo = makeWorkerRepo();
      const serviceAreaRepo = makeServiceAreaRepo();
      const useCase = new SaveServiceAreaUseCase(workerRepo as any, serviceAreaRepo as any);

      const result = await useCase.execute(serviceAreaPayload, ATTR);

      expect(result.isFailure).toBe(false);
      const returnedWorker = result.getValue();
      // currentStep deve permanecer 1 (não avançar para 4)
      expect(returnedWorker.currentStep).toBe(1);
    });

    it('deve aceitar endereço sem complemento', async () => {
      const workerRepo = makeWorkerRepo();
      const serviceAreaRepo = makeServiceAreaRepo();
      const useCase = new SaveServiceAreaUseCase(workerRepo as any, serviceAreaRepo as any);

      const result = await useCase.execute({
        workerId: 'worker-123',
        address: 'Rua sem complemento',
        serviceRadiusKm: 5,
        lat: -34.0,
        lng: -58.0,
      }, ATTR);

      expect(result.isFailure).toBe(false);
    });

    it('deve repassar city, postalCode e neighborhood ao repositório quando fornecidos', async () => {
      const workerRepo = makeWorkerRepo();
      const serviceAreaRepo = makeServiceAreaRepo();
      const useCase = new SaveServiceAreaUseCase(workerRepo as any, serviceAreaRepo as any);

      await useCase.execute({
        ...serviceAreaPayload,
        city: 'Buenos Aires',
        postalCode: 'C1043',
        neighborhood: 'Palermo',
      }, ATTR);

      expect(serviceAreaRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          city: 'Buenos Aires',
          postalCode: 'C1043',
          neighborhood: 'Palermo',
        })
      );
    });

    it('deve passar city/postalCode/neighborhood como undefined quando não fornecidos', async () => {
      const workerRepo = makeWorkerRepo();
      const serviceAreaRepo = makeServiceAreaRepo();
      const useCase = new SaveServiceAreaUseCase(workerRepo as any, serviceAreaRepo as any);

      await useCase.execute(serviceAreaPayload, ATTR);

      expect(serviceAreaRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          city: undefined,
          postalCode: undefined,
          neighborhood: undefined,
        })
      );
    });

    it('deve garantir upsert: salvar 2x gera apenas 1 registro (delete + insert)', async () => {
      const workerRepo = makeWorkerRepo();
      const serviceAreaRepo = makeServiceAreaRepo();
      const useCase = new SaveServiceAreaUseCase(workerRepo as any, serviceAreaRepo as any);

      await useCase.execute(serviceAreaPayload, ATTR);
      await useCase.execute({ ...serviceAreaPayload, serviceRadiusKm: 20 }, ATTR);

      // deleteByWorkerId deve ter sido chamado nas 2 saves
      expect(serviceAreaRepo.deleteByWorkerId).toHaveBeenCalledTimes(2);
      expect(serviceAreaRepo.create).toHaveBeenCalledTimes(2);
    });
  });

  describe('worker não encontrado', () => {
    it('deve falhar se worker não existe', async () => {
      const workerRepo = makeWorkerRepo({
        findById: jest.fn().mockResolvedValue(Result.ok(null)),
      });
      const serviceAreaRepo = makeServiceAreaRepo();
      const useCase = new SaveServiceAreaUseCase(workerRepo as any, serviceAreaRepo as any);

      const result = await useCase.execute(serviceAreaPayload, ATTR);

      expect(result.isFailure).toBe(true);
      expect(result.error).toBe('Worker not found');
      expect(serviceAreaRepo.deleteByWorkerId).not.toHaveBeenCalled();
      expect(serviceAreaRepo.create).not.toHaveBeenCalled();
    });
  });

  describe('falha no repositório de área', () => {
    it('deve propagar erro do create', async () => {
      const workerRepo = makeWorkerRepo();
      const serviceAreaRepo = makeServiceAreaRepo({
        create: jest.fn().mockResolvedValue(Result.fail('Failed to create service area')),
      });
      const useCase = new SaveServiceAreaUseCase(workerRepo as any, serviceAreaRepo as any);

      const result = await useCase.execute(serviceAreaPayload, ATTR);

      expect(result.isFailure).toBe(true);
      expect(result.error).toBe('Failed to create service area');
      expect(workerRepo.updateStep).not.toHaveBeenCalled();
    });
  });

  describe('trilha (FR-53)', () => {
    beforeEach(() => mockRecordBatch.mockClear());

    it('T-F2b-05 grava endereço mascarado, sem o valor em claro', async () => {
      const serviceAreaRepo = makeServiceAreaRepo({ findByWorkerId: jest.fn().mockResolvedValue(Result.ok([])) });
      const useCase = new SaveServiceAreaUseCase(makeWorkerRepo() as any, serviceAreaRepo as any);

      await useCase.execute(serviceAreaPayload, ATTR);

      expect(mockRecordBatch).toHaveBeenCalledTimes(1);
      const entradas = mockRecordBatch.mock.calls[0][0];
      expect(entradas).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ fieldName: 'serviceAddress', oldValueRedacted: null, newValueRedacted: '***', changedBy: 'worker_self', source: 'platform' }),
        ]),
      );
      expect(JSON.stringify(entradas)).not.toContain('Corrientes');
    });

    it('T-F2b-05 não grava o que não mudou', async () => {
      const serviceAreaRepo = makeServiceAreaRepo({ findByWorkerId: jest.fn().mockResolvedValue(Result.ok([mockServiceArea])) });
      const useCase = new SaveServiceAreaUseCase(makeWorkerRepo() as any, serviceAreaRepo as any);

      await useCase.execute(serviceAreaPayload, ATTR);

      expect(mockRecordBatch).not.toHaveBeenCalled();
    });

    it('T-F2b-05 canal app vai para a coluna source', async () => {
      const serviceAreaRepo = makeServiceAreaRepo({ findByWorkerId: jest.fn().mockResolvedValue(Result.ok([])) });
      const useCase = new SaveServiceAreaUseCase(makeWorkerRepo() as any, serviceAreaRepo as any);

      await useCase.execute(serviceAreaPayload, { ...ATTR, channel: 'app' });

      expect(mockRecordBatch.mock.calls[0][0]).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'app' })]));
    });

    it('T-F2b-05 falha ao ler o antes não derruba o save e pula a trilha', async () => {
      const serviceAreaRepo = makeServiceAreaRepo({ findByWorkerId: jest.fn().mockRejectedValue(new Error('db down')) });
      const useCase = new SaveServiceAreaUseCase(makeWorkerRepo() as any, serviceAreaRepo as any);

      const result = await useCase.execute(serviceAreaPayload, ATTR);

      expect(result.isFailure).toBe(false);
      expect(mockRecordBatch).not.toHaveBeenCalled();
    });
  });
});
