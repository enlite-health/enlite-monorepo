import { WorkerProfileGetCapability } from '../WorkerProfileGetCapability';
import type { GetWorkerByIdUseCase } from '../../../../worker/application/GetWorkerByIdUseCase';
import type { Worker } from '../../../../worker/domain/Worker';

function makeUseCase(
  result?: Partial<{ worker: Worker }>,
  throws?: Error,
): jest.Mocked<Pick<GetWorkerByIdUseCase, 'execute'>> {
  return {
    execute: throws
      ? jest.fn().mockRejectedValue(throws)
      : jest.fn().mockResolvedValue(result ?? { worker: { id: 'uuid-1' } }),
  };
}

const VALID_ARGS = { workerId: '123e4567-e89b-12d3-a456-426614174000' };

describe('WorkerProfileGetCapability', () => {
  // Statics
  it('NAME is worker.profile.get', () => {
    expect(WorkerProfileGetCapability.NAME).toBe('worker.profile.get');
  });

  it('DESCRIPTION is a non-empty string', () => {
    expect(typeof WorkerProfileGetCapability.DESCRIPTION).toBe('string');
    expect(WorkerProfileGetCapability.DESCRIPTION.length).toBeGreaterThan(0);
  });

  it('INPUT_SHAPE has workerId field', () => {
    expect(WorkerProfileGetCapability.INPUT_SHAPE).toHaveProperty('workerId');
  });

  // execute — success
  it('success: delegates to use case and returns result', async () => {
    const expected = { worker: { id: VALID_ARGS.workerId } as Worker };
    const useCase = makeUseCase(expected);
    const cap = new WorkerProfileGetCapability(useCase as unknown as GetWorkerByIdUseCase);

    const result = await cap.execute(VALID_ARGS);

    expect(useCase.execute).toHaveBeenCalledWith(VALID_ARGS.workerId);
    expect(result).toBe(expected);
  });

  // execute — use case throws
  it('propagates error from use case', async () => {
    const err = new Error('Worker not found');
    const useCase = makeUseCase(undefined, err);
    const cap = new WorkerProfileGetCapability(useCase as unknown as GetWorkerByIdUseCase);

    await expect(cap.execute(VALID_ARGS)).rejects.toThrow('Worker not found');
  });

  // execute — invalid args (Zod)
  it('throws ZodError for invalid workerId (not a UUID)', async () => {
    const useCase = makeUseCase();
    const cap = new WorkerProfileGetCapability(useCase as unknown as GetWorkerByIdUseCase);

    await expect(cap.execute({ workerId: 'not-a-uuid' })).rejects.toThrow();
    expect(useCase.execute).not.toHaveBeenCalled();
  });

  it('throws ZodError when workerId is missing', async () => {
    const useCase = makeUseCase();
    const cap = new WorkerProfileGetCapability(useCase as unknown as GetWorkerByIdUseCase);

    await expect(cap.execute({})).rejects.toThrow();
    expect(useCase.execute).not.toHaveBeenCalled();
  });
});
