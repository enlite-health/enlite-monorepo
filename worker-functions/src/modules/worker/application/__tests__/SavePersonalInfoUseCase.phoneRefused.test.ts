import { SavePersonalInfoUseCase } from '../SavePersonalInfoUseCase';
import { Result } from '@shared/utils/Result';

const baseWorker = {
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

const makeRepository = (worker: Record<string, unknown>) => ({
  findById: jest.fn().mockResolvedValue(Result.ok(worker)),
  updatePersonalInfo: jest.fn().mockResolvedValue(Result.ok(worker)),
  findByPhoneCandidates: jest.fn().mockResolvedValue(Result.ok(null)),
  recalculateStatus: jest.fn().mockResolvedValue(null),
});

const payload = {
  workerId: 'worker-123',
  firstName: 'Gabriel',
  lastName: 'Stein',
  termsAccepted: true,
  privacyAccepted: true,
};

describe('SavePersonalInfoUseCase — troca de telefone sem código (emenda §6, AC-15)', () => {
  it('T-F3c-144 phone diferente do atual numa ficha com telefone: recusado com código estável e nada gravado', async () => {
    const repo = makeRepository({ ...baseWorker, phone: '5491100000000' });
    const useCase = new SavePersonalInfoUseCase(repo as any);

    const result = await useCase.execute({ ...payload, phone: '1151265663' } as any);

    expect(result.isFailure).toBe(true);
    expect(result.error).toBe('PHONE_CHANGE_REQUIRES_VERIFICATION');
    expect(repo.updatePersonalInfo).not.toHaveBeenCalled();
    expect(repo.recalculateStatus).not.toHaveBeenCalled();
  });

  it('T-F3c-144 phone igual ao atual (mesmo em outro formato): aceito sem troca', async () => {
    const repo = makeRepository({ ...baseWorker, phone: '1151265663' });
    const useCase = new SavePersonalInfoUseCase(repo as any);

    const result = await useCase.execute({ ...payload, phone: '+5491151265663' } as any);

    expect(result.isFailure).toBe(false);
    expect(repo.updatePersonalInfo).toHaveBeenCalledWith(expect.objectContaining({ phone: '' }));
  });

  it('T-F3c-144 ficha SEM telefone: o primeiro registro segue sem código', async () => {
    const repo = makeRepository({ ...baseWorker });
    const useCase = new SavePersonalInfoUseCase(repo as any);

    const result = await useCase.execute({ ...payload, phone: '1151265663' } as any);

    expect(result.isFailure).toBe(false);
    expect(repo.updatePersonalInfo).toHaveBeenCalledWith(expect.objectContaining({ phone: '5491151265663' }));
  });
});
