/**
 * ListAvailableVacanciesForWorkerUseCase.test.ts
 */

const mockFindActiveByWorkerId = jest.fn();

jest.mock('../../infrastructure/WorkerApplicationRepository', () => ({
  WorkerApplicationRepository: jest.fn().mockImplementation(() => ({
    findActiveByWorkerId: mockFindActiveByWorkerId,
  })),
}));

jest.mock('@shared/logging', () => ({
  logger: { child: jest.fn().mockReturnValue({ info: jest.fn(), error: jest.fn() }) },
  reportError: jest.fn(),
}));

import { ListAvailableVacanciesForWorkerUseCase } from '../ListAvailableVacanciesForWorkerUseCase';

describe('ListAvailableVacanciesForWorkerUseCase', () => {
  const useCase = new ListAvailableVacanciesForWorkerUseCase();

  beforeEach(() => jest.clearAllMocks());

  it('retorna lista vazia quando worker não tem aplicações ativas', async () => {
    mockFindActiveByWorkerId.mockResolvedValue([]);

    const result = await useCase.execute('worker-1');

    expect(result).toEqual({ vacancies: [] });
  });

  it('retorna lista de vagas com todos os campos', async () => {
    const vacancy = {
      id: 'vac-1',
      title: 'Caso #50-2',
      status: 'OPEN',
      city: 'Buenos Aires',
      startDate: '2026-05-01',
      funnelStage: 'INITIATED',
    };
    mockFindActiveByWorkerId.mockResolvedValue([vacancy]);

    const result = await useCase.execute('worker-1');

    expect(result.vacancies).toHaveLength(1);
    expect(result.vacancies[0]).toMatchObject(vacancy);
  });

  it('retorna vaga sem city quando patient_address é null', async () => {
    mockFindActiveByWorkerId.mockResolvedValue([
      { id: 'vac-2', title: 'Caso #99-1', status: 'OPEN', funnelStage: 'QUALIFIED' },
    ]);

    const result = await useCase.execute('worker-x');

    expect(result.vacancies[0].city).toBeUndefined();
  });
});
