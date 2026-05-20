import { WorkerInterviewGetCapability } from '../WorkerInterviewGetCapability';
import type {
  GetCurrentInterviewUseCase,
  GetCurrentInterviewResult,
} from '../../../../matching/application/GetCurrentInterviewUseCase';

const VALID_ARGS = { workerId: '123e4567-e89b-12d3-a456-426614174000' };

function makeUseCase(
  result?: GetCurrentInterviewResult,
  throws?: Error,
): jest.Mocked<Pick<GetCurrentInterviewUseCase, 'execute'>> {
  return {
    execute: throws
      ? jest.fn().mockRejectedValue(throws)
      : jest.fn().mockResolvedValue(result ?? { interview: null }),
  };
}

describe('WorkerInterviewGetCapability', () => {
  it('NAME is worker.interview.get', () => {
    expect(WorkerInterviewGetCapability.NAME).toBe('worker.interview.get');
  });

  it('DESCRIPTION is a non-empty string', () => {
    expect(typeof WorkerInterviewGetCapability.DESCRIPTION).toBe('string');
    expect(WorkerInterviewGetCapability.DESCRIPTION.length).toBeGreaterThan(0);
  });

  it('INPUT_SHAPE has workerId field', () => {
    expect(WorkerInterviewGetCapability.INPUT_SHAPE).toHaveProperty('workerId');
  });

  // success — interview exists
  it('success: returns interview when found', async () => {
    const expected: GetCurrentInterviewResult = {
      interview: {
        vacancyTitle: 'CASO 10-1',
        scheduledFor: '2026-06-01T10:00:00-03:00',
        meetLink: 'https://meet.google.com/abc',
        status: 'pending',
      },
    };
    const useCase = makeUseCase(expected);
    const cap = new WorkerInterviewGetCapability(
      useCase as unknown as GetCurrentInterviewUseCase,
    );

    const result = await cap.execute(VALID_ARGS);

    expect(useCase.execute).toHaveBeenCalledWith(VALID_ARGS.workerId);
    expect(result).toBe(expected);
  });

  // success — no interview (null)
  it('success: returns null interview when none scheduled', async () => {
    const useCase = makeUseCase({ interview: null });
    const cap = new WorkerInterviewGetCapability(
      useCase as unknown as GetCurrentInterviewUseCase,
    );

    const result = await cap.execute(VALID_ARGS);
    expect(result).toEqual({ interview: null });
  });

  // use case throws
  it('propagates error from use case', async () => {
    const err = new Error('DB error');
    const useCase = makeUseCase(undefined, err);
    const cap = new WorkerInterviewGetCapability(
      useCase as unknown as GetCurrentInterviewUseCase,
    );

    await expect(cap.execute(VALID_ARGS)).rejects.toThrow('DB error');
  });

  // Zod validation
  it('throws ZodError for non-UUID workerId', async () => {
    const useCase = makeUseCase();
    const cap = new WorkerInterviewGetCapability(
      useCase as unknown as GetCurrentInterviewUseCase,
    );

    await expect(cap.execute({ workerId: 'bad-id' })).rejects.toThrow();
    expect(useCase.execute).not.toHaveBeenCalled();
  });

  it('throws ZodError when workerId is missing', async () => {
    const useCase = makeUseCase();
    const cap = new WorkerInterviewGetCapability(
      useCase as unknown as GetCurrentInterviewUseCase,
    );

    await expect(cap.execute({})).rejects.toThrow();
  });
});
