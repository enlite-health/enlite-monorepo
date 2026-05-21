/**
 * GetCurrentInterviewUseCase.test.ts
 */

const mockFindUpcomingByWorkerId = jest.fn();

jest.mock('../../infrastructure/EncuadreQueryRepository', () => ({
  EncuadreQueryRepository: jest.fn().mockImplementation(() => ({
    findUpcomingByWorkerId: mockFindUpcomingByWorkerId,
  })),
}));

jest.mock('@shared/logging', () => ({
  logger: { child: jest.fn().mockReturnValue({ info: jest.fn(), error: jest.fn() }) },
  reportError: jest.fn(),
}));

import { GetCurrentInterviewUseCase } from '../GetCurrentInterviewUseCase';

describe('GetCurrentInterviewUseCase', () => {
  const useCase = new GetCurrentInterviewUseCase();

  beforeEach(() => jest.clearAllMocks());

  it('retorna { interview: null } quando não há encuadre agendado', async () => {
    mockFindUpcomingByWorkerId.mockResolvedValue(null);

    const result = await useCase.execute('worker-1');

    expect(result).toEqual({ interview: null });
    expect(mockFindUpcomingByWorkerId).toHaveBeenCalledWith('worker-1');
  });

  it('retorna entrevista com campos corretos quando há encuadre', async () => {
    mockFindUpcomingByWorkerId.mockResolvedValue({
      encuadreId: 'enc-1',
      slotDate: '2026-06-01',
      slotTime: '10:00:00',
      meetLink: 'https://meet.google.com/abc',
      vacancyId: 'vac-1',
      vacancyTitle: 'Caso #100-1',
      vacancyTimezone: 'America/Argentina/Buenos_Aires',
      scheduledFor: '2026-06-01T10:00:00',
    });

    const result = await useCase.execute('worker-1');

    expect(result.interview).not.toBeNull();
    expect(result.interview!.vacancyTitle).toBe('Caso #100-1');
    expect(result.interview!.meetLink).toBe('https://meet.google.com/abc');
    expect(result.interview!.status).toBe('pending');
    expect(result.interview!.scheduledFor).toBe('2026-06-01T10:00:00');
  });

  it('retorna meetLink null quando encuadre não tem link', async () => {
    mockFindUpcomingByWorkerId.mockResolvedValue({
      encuadreId: 'enc-2',
      slotDate: '2026-06-10',
      slotTime: '14:00:00',
      meetLink: null,
      vacancyId: 'vac-2',
      vacancyTitle: 'Caso #200-1',
      vacancyTimezone: 'America/Sao_Paulo',
      scheduledFor: '2026-06-10T14:00:00',
    });

    const result = await useCase.execute('worker-2');

    expect(result.interview!.meetLink).toBeNull();
  });
});
