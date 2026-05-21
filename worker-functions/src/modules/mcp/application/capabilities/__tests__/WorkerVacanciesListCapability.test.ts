import { WorkerVacanciesListCapability } from '../WorkerVacanciesListCapability';
import type {
  ListAvailableVacanciesForWorkerUseCase,
  ListAvailableVacanciesResult,
} from '../../../../matching/application/ListAvailableVacanciesForWorkerUseCase';

const VALID_ARGS = { workerId: '123e4567-e89b-12d3-a456-426614174000' };

function makeUseCase(
  result?: ListAvailableVacanciesResult,
  throws?: Error,
): jest.Mocked<Pick<ListAvailableVacanciesForWorkerUseCase, 'execute'>> {
  return {
    execute: throws
      ? jest.fn().mockRejectedValue(throws)
      : jest.fn().mockResolvedValue(result ?? { vacancies: [] }),
  };
}

describe('WorkerVacanciesListCapability', () => {
  it('NAME is worker.vacancies.list', () => {
    expect(WorkerVacanciesListCapability.NAME).toBe('worker.vacancies.list');
  });

  it('DESCRIPTION is a non-empty string', () => {
    expect(typeof WorkerVacanciesListCapability.DESCRIPTION).toBe('string');
    expect(WorkerVacanciesListCapability.DESCRIPTION.length).toBeGreaterThan(0);
  });

  it('INPUT_SHAPE has workerId field', () => {
    expect(WorkerVacanciesListCapability.INPUT_SHAPE).toHaveProperty('workerId');
  });

  // success
  it('success: delegates to use case and returns result', async () => {
    const expected: ListAvailableVacanciesResult = {
      vacancies: [{ id: 'v-1', title: 'CASO 10-1', status: 'OPEN', funnelStage: 'invited' }],
    };
    const useCase = makeUseCase(expected);
    const cap = new WorkerVacanciesListCapability(
      useCase as unknown as ListAvailableVacanciesForWorkerUseCase,
    );

    const result = await cap.execute(VALID_ARGS);

    expect(useCase.execute).toHaveBeenCalledWith(VALID_ARGS.workerId);
    expect(result).toBe(expected);
  });

  // success — empty list
  it('success: empty vacancies list', async () => {
    const useCase = makeUseCase({ vacancies: [] });
    const cap = new WorkerVacanciesListCapability(
      useCase as unknown as ListAvailableVacanciesForWorkerUseCase,
    );

    const result = await cap.execute(VALID_ARGS);
    expect(result).toEqual({ vacancies: [] });
  });

  // use case throws
  it('propagates error from use case', async () => {
    const err = new Error('Repo unavailable');
    const useCase = makeUseCase(undefined, err);
    const cap = new WorkerVacanciesListCapability(
      useCase as unknown as ListAvailableVacanciesForWorkerUseCase,
    );

    await expect(cap.execute(VALID_ARGS)).rejects.toThrow('Repo unavailable');
  });

  // Zod validation
  it('throws ZodError for non-UUID workerId', async () => {
    const useCase = makeUseCase();
    const cap = new WorkerVacanciesListCapability(
      useCase as unknown as ListAvailableVacanciesForWorkerUseCase,
    );

    await expect(cap.execute({ workerId: 'not-uuid' })).rejects.toThrow();
    expect(useCase.execute).not.toHaveBeenCalled();
  });

  it('throws ZodError when workerId is missing', async () => {
    const useCase = makeUseCase();
    const cap = new WorkerVacanciesListCapability(
      useCase as unknown as ListAvailableVacanciesForWorkerUseCase,
    );

    await expect(cap.execute({})).rejects.toThrow();
  });
});
