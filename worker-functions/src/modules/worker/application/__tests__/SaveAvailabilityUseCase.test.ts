import { SaveAvailabilityUseCase } from '../SaveAvailabilityUseCase';
import { Result } from '@shared/utils/Result';

const mockWorker = {
  id: 'worker-123',
  authUid: 'auth-123',
  email: 'test@example.com',
  currentStep: 1,
  status: 'INCOMPLETE_REGISTER',
  country: 'AR',
  timezone: 'America/Argentina/Buenos_Aires',
  registrationCompleted: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const makeWorkerRepo = (overrides = {}) => ({
  findById: jest.fn().mockResolvedValue(Result.ok(mockWorker)),
  updateStep: jest.fn().mockResolvedValue(Result.ok({ ...mockWorker, currentStep: 5, status: 'REGISTERED' })),
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

const makeAvailabilityRepo = (overrides = {}) => ({
  replaceByWorkerId: jest.fn().mockResolvedValue(Result.ok(undefined)),
  deleteByWorkerId: jest.fn().mockResolvedValue(Result.ok(undefined)),
  createBatch: jest.fn().mockResolvedValue(Result.ok([])),
  findByWorkerId: jest.fn(),
  ...overrides,
});

const availabilityPayload = {
  workerId: 'worker-123',
  availability: [
    { dayOfWeek: 1, startTime: '09:00', endTime: '17:00' },
    { dayOfWeek: 3, startTime: '08:00', endTime: '12:00' },
    { dayOfWeek: 5, startTime: '14:00', endTime: '18:00' },
  ],
};

describe('SaveAvailabilityUseCase', () => {
  describe('sucesso', () => {
    it('deve substituir os slots via replaceByWorkerId (transação única)', async () => {
      const workerRepo = makeWorkerRepo();
      const availabilityRepo = makeAvailabilityRepo();
      const useCase = new SaveAvailabilityUseCase(workerRepo as any, availabilityRepo as any);

      const result = await useCase.execute(availabilityPayload);

      expect(result.isFailure).toBe(false);
      expect(availabilityRepo.replaceByWorkerId).toHaveBeenCalledWith(
        'worker-123',
        expect.arrayContaining([
          expect.objectContaining({ workerId: 'worker-123', dayOfWeek: 1, startTime: '09:00', endTime: '17:00' }),
          expect.objectContaining({ workerId: 'worker-123', dayOfWeek: 3 }),
          expect.objectContaining({ workerId: 'worker-123', dayOfWeek: 5 }),
        ])
      );
      // O caminho antigo (delete e insert em transações separadas) não existe mais
      expect(availabilityRepo.deleteByWorkerId).not.toHaveBeenCalled();
      expect(availabilityRepo.createBatch).not.toHaveBeenCalled();
    });

    it('NÃO deve chamar updateStep — sem avanço de step na edição por abas', async () => {
      const workerRepo = makeWorkerRepo();
      const availabilityRepo = makeAvailabilityRepo();
      const useCase = new SaveAvailabilityUseCase(workerRepo as any, availabilityRepo as any);

      await useCase.execute(availabilityPayload);

      expect(workerRepo.updateStep).not.toHaveBeenCalled();
    });

    it('deve incluir timezone do worker em cada slot', async () => {
      const workerRepo = makeWorkerRepo();
      const availabilityRepo = makeAvailabilityRepo();
      const useCase = new SaveAvailabilityUseCase(workerRepo as any, availabilityRepo as any);

      await useCase.execute(availabilityPayload);

      const slotsArg = availabilityRepo.replaceByWorkerId.mock.calls[0][1];
      expect(slotsArg[0].timezone).toBe('America/Argentina/Buenos_Aires');
      expect(slotsArg[1].timezone).toBe('America/Argentina/Buenos_Aires');
    });

    it('deve definir crossesMidnight como false por padrão', async () => {
      const workerRepo = makeWorkerRepo();
      const availabilityRepo = makeAvailabilityRepo();
      const useCase = new SaveAvailabilityUseCase(workerRepo as any, availabilityRepo as any);

      await useCase.execute(availabilityPayload);

      const slotsArg = availabilityRepo.replaceByWorkerId.mock.calls[0][1];
      slotsArg.forEach((slot: any) => {
        expect(slot.crossesMidnight).toBe(false);
      });
    });

    it('deve respeitar crossesMidnight quando informado (turno noturno)', async () => {
      const workerRepo = makeWorkerRepo();
      const availabilityRepo = makeAvailabilityRepo();
      const useCase = new SaveAvailabilityUseCase(workerRepo as any, availabilityRepo as any);

      const result = await useCase.execute({
        workerId: 'worker-123',
        availability: [{ dayOfWeek: 6, startTime: '22:00', endTime: '02:00', crossesMidnight: true }],
      });

      expect(result.isFailure).toBe(false);
      const slotsArg = availabilityRepo.replaceByWorkerId.mock.calls[0][1];
      expect(slotsArg[0].crossesMidnight).toBe(true);
    });

    it('deve retornar o worker original (sem status review forçado)', async () => {
      const workerRepo = makeWorkerRepo();
      const availabilityRepo = makeAvailabilityRepo();
      const useCase = new SaveAvailabilityUseCase(workerRepo as any, availabilityRepo as any);

      const result = await useCase.execute(availabilityPayload);

      expect(result.isFailure).toBe(false);
      // status deve ser INCOMPLETE_REGISTER (do worker original), não REGISTERED
      expect(result.getValue()?.status).toBe('INCOMPLETE_REGISTER');
    });
  });

  describe('validação antes do banco (bug do wipe: payload inválido NUNCA pode tocar o repositório)', () => {
    it('deve rejeitar fim < início sem chamar o repositório', async () => {
      const workerRepo = makeWorkerRepo();
      const availabilityRepo = makeAvailabilityRepo();
      const useCase = new SaveAvailabilityUseCase(workerRepo as any, availabilityRepo as any);

      const result = await useCase.execute({
        workerId: 'worker-123',
        availability: [{ dayOfWeek: 1, startTime: '20:00', endTime: '17:00' }],
      });

      expect(result.isFailure).toBe(true);
      expect(result.error).toContain('lunes');
      expect(result.error).toContain('la hora de fin debe ser posterior a la de inicio');
      expect(availabilityRepo.replaceByWorkerId).not.toHaveBeenCalled();
      expect(workerRepo.recalculateStatus).not.toHaveBeenCalled();
    });

    it('deve rejeitar fim == início sem chamar o repositório', async () => {
      const workerRepo = makeWorkerRepo();
      const availabilityRepo = makeAvailabilityRepo();
      const useCase = new SaveAvailabilityUseCase(workerRepo as any, availabilityRepo as any);

      const result = await useCase.execute({
        workerId: 'worker-123',
        availability: [{ dayOfWeek: 2, startTime: '09:00', endTime: '09:00' }],
      });

      expect(result.isFailure).toBe(true);
      expect(availabilityRepo.replaceByWorkerId).not.toHaveBeenCalled();
    });

    it('deve aceitar fim <= início quando crossesMidnight=true', async () => {
      const workerRepo = makeWorkerRepo();
      const availabilityRepo = makeAvailabilityRepo();
      const useCase = new SaveAvailabilityUseCase(workerRepo as any, availabilityRepo as any);

      const result = await useCase.execute({
        workerId: 'worker-123',
        availability: [{ dayOfWeek: 5, startTime: '20:00', endTime: '08:00', crossesMidnight: true }],
      });

      expect(result.isFailure).toBe(false);
    });

    it('deve rejeitar dayOfWeek fora de 0-6 sem chamar o repositório', async () => {
      const workerRepo = makeWorkerRepo();
      const availabilityRepo = makeAvailabilityRepo();
      const useCase = new SaveAvailabilityUseCase(workerRepo as any, availabilityRepo as any);

      const result = await useCase.execute({
        workerId: 'worker-123',
        availability: [{ dayOfWeek: 7, startTime: '09:00', endTime: '17:00' }],
      });

      expect(result.isFailure).toBe(true);
      expect(availabilityRepo.replaceByWorkerId).not.toHaveBeenCalled();
    });

    it('deve rejeitar hora com formato inválido sem chamar o repositório', async () => {
      const workerRepo = makeWorkerRepo();
      const availabilityRepo = makeAvailabilityRepo();
      const useCase = new SaveAvailabilityUseCase(workerRepo as any, availabilityRepo as any);

      const result = await useCase.execute({
        workerId: 'worker-123',
        availability: [{ dayOfWeek: 1, startTime: '9am', endTime: '17:00' }],
      });

      expect(result.isFailure).toBe(true);
      expect(availabilityRepo.replaceByWorkerId).not.toHaveBeenCalled();
    });

    it('deve deduplicar slots idênticos em silêncio (duplo toque no "+")', async () => {
      const workerRepo = makeWorkerRepo();
      const availabilityRepo = makeAvailabilityRepo();
      const useCase = new SaveAvailabilityUseCase(workerRepo as any, availabilityRepo as any);

      const result = await useCase.execute({
        workerId: 'worker-123',
        availability: [
          { dayOfWeek: 1, startTime: '09:00', endTime: '17:00' },
          { dayOfWeek: 1, startTime: '09:00', endTime: '17:00' },
          { dayOfWeek: 2, startTime: '09:00', endTime: '17:00' },
        ],
      });

      expect(result.isFailure).toBe(false);
      const slotsArg = availabilityRepo.replaceByWorkerId.mock.calls[0][1];
      expect(slotsArg).toHaveLength(2);
      expect(slotsArg.map((s: any) => s.dayOfWeek)).toEqual([1, 2]);
    });
  });

  describe('validação: lista vazia', () => {
    it('deve falhar se availability estiver vazia', async () => {
      const workerRepo = makeWorkerRepo();
      const availabilityRepo = makeAvailabilityRepo();
      const useCase = new SaveAvailabilityUseCase(workerRepo as any, availabilityRepo as any);

      const result = await useCase.execute({ workerId: 'worker-123', availability: [] });

      expect(result.isFailure).toBe(true);
      expect(result.error).toBe('Dejá al menos un día con horario cargado.');
      expect(availabilityRepo.replaceByWorkerId).not.toHaveBeenCalled();
    });
  });

  describe('worker não encontrado', () => {
    it('deve falhar se worker não existe', async () => {
      const workerRepo = makeWorkerRepo({
        findById: jest.fn().mockResolvedValue(Result.ok(null)),
      });
      const availabilityRepo = makeAvailabilityRepo();
      const useCase = new SaveAvailabilityUseCase(workerRepo as any, availabilityRepo as any);

      const result = await useCase.execute(availabilityPayload);

      expect(result.isFailure).toBe(true);
      expect(result.error).toBe('No encontramos tu registro. Cerrá sesión y volvé a entrar.');
      expect(availabilityRepo.replaceByWorkerId).not.toHaveBeenCalled();
    });
  });

  describe('timezone fallback', () => {
    it('deve usar UTC quando worker.timezone é nulo', async () => {
      const workerRepo = makeWorkerRepo({
        findById: jest.fn().mockResolvedValue(Result.ok({ ...mockWorker, timezone: null })),
      });
      const availabilityRepo = makeAvailabilityRepo();
      const useCase = new SaveAvailabilityUseCase(workerRepo as any, availabilityRepo as any);

      await useCase.execute(availabilityPayload);

      const slotsArg = availabilityRepo.replaceByWorkerId.mock.calls[0][1];
      slotsArg.forEach((slot: any) => {
        expect(slot.timezone).toBe('UTC');
      });
    });
  });

  describe('falha no repositório', () => {
    it('falha do replaceByWorkerId vira mensagem amigável (técnico só no log), sem recalcular status', async () => {
      const workerRepo = makeWorkerRepo();
      const availabilityRepo = makeAvailabilityRepo({
        replaceByWorkerId: jest.fn().mockResolvedValue(Result.fail('duplicate key value violates unique constraint')),
      });
      const useCase = new SaveAvailabilityUseCase(workerRepo as any, availabilityRepo as any);
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      const result = await useCase.execute(availabilityPayload);

      expect(result.isFailure).toBe(true);
      // O prestador vê texto acionável em es, nunca o erro SQL
      expect(result.error).toBe('No pudimos guardar tu disponibilidad. Esperá un momento y probá de nuevo.');
      expect(result.error).not.toContain('duplicate key');
      // O técnico fica no log
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('duplicate key value violates unique constraint'));
      expect(workerRepo.updateStep).not.toHaveBeenCalled();
      expect(workerRepo.recalculateStatus).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });
  });
});
