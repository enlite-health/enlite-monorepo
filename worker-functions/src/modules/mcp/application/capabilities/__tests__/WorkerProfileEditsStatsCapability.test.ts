import { WorkerProfileEditsStatsCapability } from '../WorkerProfileEditsStatsCapability';
import type { GetProfileEditsStatsUseCase } from '../../../../worker/application/GetProfileEditsStatsUseCase';

function makeUseCase() {
  return {
    execute: jest.fn().mockResolvedValue({ sinceDays: 30, totalEdits: 0, bySource: [] }),
  } as jest.Mocked<Pick<GetProfileEditsStatsUseCase, 'execute'>>;
}

function makeCap(useCase = makeUseCase()) {
  return {
    cap: new WorkerProfileEditsStatsCapability(useCase as unknown as GetProfileEditsStatsUseCase),
    useCase,
  };
}

describe('WorkerProfileEditsStatsCapability', () => {
  it('NAME/DESCRIPTION estáveis', () => {
    expect(WorkerProfileEditsStatsCapability.NAME).toBe('worker.profile.edits.stats');
    expect(WorkerProfileEditsStatsCapability.DESCRIPTION).toContain('source');
  });

  it('default: sinceDays=30 quando sem args', async () => {
    const { cap, useCase } = makeCap();
    await cap.execute(undefined);
    expect(useCase.execute).toHaveBeenCalledWith({ sinceDays: 30 });
  });

  it('passa sinceDays explícito', async () => {
    const { cap, useCase } = makeCap();
    await cap.execute({ sinceDays: 7 });
    expect(useCase.execute).toHaveBeenCalledWith({ sinceDays: 7 });
  });

  it('rejeita sinceDays fora do range (0, 366, não-inteiro)', async () => {
    const { cap, useCase } = makeCap();
    await expect(cap.execute({ sinceDays: 0 })).rejects.toThrow();
    await expect(cap.execute({ sinceDays: 366 })).rejects.toThrow();
    await expect(cap.execute({ sinceDays: 1.5 })).rejects.toThrow();
    expect(useCase.execute).not.toHaveBeenCalled();
  });
});
