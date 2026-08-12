import { FunnelActivityStatsCapability } from '../FunnelActivityStatsCapability';
import type { GetFunnelActivityStatsUseCase } from '../../../../matching/application/GetFunnelActivityStatsUseCase';

function makeCapability() {
  const useCase = {
    execute: jest.fn().mockResolvedValue({ sinceDays: 30, totalActions: 0, byActor: [] }),
  };
  return {
    cap: new FunnelActivityStatsCapability(useCase as unknown as GetFunnelActivityStatsUseCase),
    useCase,
  };
}

describe('FunnelActivityStatsCapability', () => {
  it('NAME/DESCRIPTION estáveis e o limite declarado na descrição', () => {
    expect(FunnelActivityStatsCapability.NAME).toBe('funnel.activity.stats');
    // Quem lê o número precisa saber que Periskope não entra — o aviso vive aqui.
    expect(FunnelActivityStatsCapability.DESCRIPTION).toContain('Periskope');
    expect(FunnelActivityStatsCapability.DESCRIPTION).toContain('nao_instrumentado');
  });

  it('default: sinceDays=30 quando chamada sem args', async () => {
    const { cap, useCase } = makeCapability();
    await cap.execute(undefined);
    expect(useCase.execute).toHaveBeenCalledWith({ sinceDays: 30 });
  });

  it('passa sinceDays explícito', async () => {
    const { cap, useCase } = makeCapability();
    await cap.execute({ sinceDays: 7 });
    expect(useCase.execute).toHaveBeenCalledWith({ sinceDays: 7 });
  });

  it('rejeita sinceDays fora do range e não-inteiro', async () => {
    const { cap, useCase } = makeCapability();
    await expect(cap.execute({ sinceDays: 0 })).rejects.toThrow();
    await expect(cap.execute({ sinceDays: 366 })).rejects.toThrow();
    await expect(cap.execute({ sinceDays: 1.5 })).rejects.toThrow();
    expect(useCase.execute).not.toHaveBeenCalled();
  });
});
