import { WorkerSearchCapability } from '../WorkerSearchCapability';

describe('WorkerSearchCapability', () => {
  const emptyResult = { workers: [], total: 0, limit: 20, offset: 0 };

  function makeCap() {
    const useCase = { execute: jest.fn().mockResolvedValue(emptyResult) };
    return { cap: new WorkerSearchCapability(useCase as never), useCase };
  }

  it('NAME correto e defaults de paginação aplicados', async () => {
    expect(WorkerSearchCapability.NAME).toBe('worker.search');
    const { cap, useCase } = makeCap();
    await cap.execute({});
    expect(useCase.execute).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 20, offset: 0 }),
    );
  });

  it('propaga filtros válidos', async () => {
    const { cap, useCase } = makeCap();
    await cap.execute({ search: 'ana', status: 'REGISTERED', profession: 'AT', limit: 50, offset: 10 });
    expect(useCase.execute).toHaveBeenCalledWith(
      expect.objectContaining({ search: 'ana', status: 'REGISTERED', profession: 'AT', limit: 50, offset: 10 }),
    );
  });

  it('rejeita limit acima de 50 e search curto', async () => {
    const { cap } = makeCap();
    await expect(cap.execute({ limit: 51 })).rejects.toThrow();
    await expect(cap.execute({ search: 'ab' })).rejects.toThrow();
  });
});
