import { SaveStepUseCase } from '../SaveStepUseCase';
import { Result } from '@shared/utils/Result';

describe('SaveStepUseCase — fluxo declarado (spec 093)', () => {
  it('recalcula o status declarando WIZARD_STEP', async () => {
    const repo = {
      findById: jest.fn().mockResolvedValue(Result.ok({ id: 'worker-123', currentStep: 0 })),
      recalculateStatus: jest.fn().mockResolvedValue(null),
    };

    const result = await new SaveStepUseCase(repo as never).execute({ workerId: 'worker-123', step: 1 });

    expect(result.isFailure).toBe(false);
    expect(repo.recalculateStatus).toHaveBeenCalledWith('worker-123', { flow: 'WIZARD_STEP' });
  });

  it('não recalcula ao tentar voltar de step', async () => {
    const repo = {
      findById: jest.fn().mockResolvedValue(Result.ok({ id: 'worker-123', currentStep: 3 })),
      recalculateStatus: jest.fn(),
    };

    const result = await new SaveStepUseCase(repo as never).execute({ workerId: 'worker-123', step: 1 });

    expect(result.isFailure).toBe(true);
    expect(repo.recalculateStatus).not.toHaveBeenCalled();
  });
});
