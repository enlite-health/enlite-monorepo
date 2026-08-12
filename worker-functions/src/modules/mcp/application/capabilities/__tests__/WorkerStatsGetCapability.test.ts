import { WorkerStatsGetCapability } from '../WorkerStatsGetCapability';

describe('WorkerStatsGetCapability', () => {
  const stats = { totalWorkers: 10, byStatus: {}, applicationsByFunnelStage: {}, registeredToday: 1, registeredLast7Days: 2 };

  it('NAME/DESCRIPTION/INPUT_SHAPE definidos', () => {
    expect(WorkerStatsGetCapability.NAME).toBe('worker.stats.get');
    expect(WorkerStatsGetCapability.DESCRIPTION).toBeTruthy();
    expect(WorkerStatsGetCapability.INPUT_SHAPE).toEqual({});
  });

  it('executa sem args (undefined e {})', async () => {
    const useCase = { execute: jest.fn().mockResolvedValue(stats) };
    const cap = new WorkerStatsGetCapability(useCase as never);
    await expect(cap.execute(undefined)).resolves.toEqual(stats);
    await expect(cap.execute({})).resolves.toEqual(stats);
    expect(useCase.execute).toHaveBeenCalledTimes(2);
  });

  it('ignora args extras (strip)', async () => {
    const useCase = { execute: jest.fn().mockResolvedValue(stats) };
    const cap = new WorkerStatsGetCapability(useCase as never);
    await expect(cap.execute({ foo: 'bar' })).resolves.toEqual(stats);
  });
});
