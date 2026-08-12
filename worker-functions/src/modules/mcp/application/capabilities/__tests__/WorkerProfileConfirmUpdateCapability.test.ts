import { WorkerProfileConfirmUpdateCapability } from '../WorkerProfileConfirmUpdateCapability';
import type { ConfirmWorkerProfileUpdateUseCase } from '@modules/worker/application/ConfirmWorkerProfileUpdateUseCase';

const WORKER_ID = '123e4567-e89b-12d3-a456-426614174000';
const HANDLE = '223e4567-e89b-12d3-a456-426614174999';

function makeUseCase(): jest.Mocked<Pick<ConfirmWorkerProfileUpdateUseCase, 'execute'>> {
  return {
    execute: jest.fn().mockResolvedValue({
      applied: true,
      workerId: WORKER_ID,
      fieldsUpdated: ['firstName'],
    }),
  };
}

function makeCap(
  useCase: jest.Mocked<Pick<ConfirmWorkerProfileUpdateUseCase, 'execute'>>,
): WorkerProfileConfirmUpdateCapability {
  return new WorkerProfileConfirmUpdateCapability(
    useCase as unknown as ConfirmWorkerProfileUpdateUseCase,
  );
}

describe('WorkerProfileConfirmUpdateCapability', () => {
  beforeEach(() => jest.clearAllMocks());

  it('NAME is worker.profile.confirmUpdate', () => {
    expect(WorkerProfileConfirmUpdateCapability.NAME).toBe('worker.profile.confirmUpdate');
  });

  it('passes workerId + handle to the use case', async () => {
    const useCase = makeUseCase();
    const cap = makeCap(useCase);

    const result = await cap.execute({ workerId: WORKER_ID, handle: HANDLE });

    expect(useCase.execute).toHaveBeenCalledWith(
      expect.objectContaining({ workerId: WORKER_ID, handle: HANDLE }),
    );
    expect(result).toMatchObject({ applied: true, fieldsUpdated: ['firstName'] });
  });

  it('handle is optional (latest pending resolved server-side)', async () => {
    const useCase = makeUseCase();
    const cap = makeCap(useCase);
    await expect(cap.execute({ workerId: WORKER_ID })).resolves.toMatchObject({
      applied: true,
    });
  });

  it('rejects attempts to pass field values (no value accepted here)', async () => {
    const useCase = makeUseCase();
    const cap = makeCap(useCase);
    await expect(
      cap.execute({ workerId: WORKER_ID, handle: HANDLE, firstName: 'Hacker' }),
    ).rejects.toThrow();
    expect(useCase.execute).not.toHaveBeenCalled();
  });

  it('invalid handle (not a UUID) is rejected', async () => {
    const useCase = makeUseCase();
    const cap = makeCap(useCase);
    await expect(
      cap.execute({ workerId: WORKER_ID, handle: 'nope' }),
    ).rejects.toThrow();
    expect(useCase.execute).not.toHaveBeenCalled();
  });

  it('invalid workerId is rejected', async () => {
    const useCase = makeUseCase();
    const cap = makeCap(useCase);
    await expect(cap.execute({ workerId: 'not-a-uuid' })).rejects.toThrow();
    expect(useCase.execute).not.toHaveBeenCalled();
  });
});
