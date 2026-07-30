import type { Pool } from 'pg';
import { GetPatientFunnelUseCase } from '../GetPatientFunnelUseCase';

/**
 * Ordem das 5 queries (Promise.all, invocação síncrona em ordem de array):
 *   1. solicitantes  → [{ n }]
 *   2. admision      → [{ n }]
 *   3. agendadas     → [{ n }]
 *   4. vacantes      → [{ n }]
 *   5. byStatus      → [{ k, count }]
 */
function mockDb(
  solicitantes: number,
  admision: number,
  agendadas: number,
  vacantes: number,
  byStatus: Array<{ k: string; count: number }>,
): { query: jest.Mock } {
  const query = jest
    .fn()
    .mockResolvedValueOnce({ rows: [{ n: solicitantes }] })
    .mockResolvedValueOnce({ rows: [{ n: admision }] })
    .mockResolvedValueOnce({ rows: [{ n: agendadas }] })
    .mockResolvedValueOnce({ rows: [{ n: vacantes }] })
    .mockResolvedValueOnce({ rows: byStatus });
  return { query };
}

describe('GetPatientFunnelUseCase', () => {
  it('agrega solicitantes, admision, agendadas, vacantes e byStatus', async () => {
    const db = mockDb(10, 6, 4, 3, [
      { k: 'SOLICITANTE', count: 4 },
      { k: 'ADMISSION', count: 3 },
      { k: 'ACTIVE', count: 3 },
    ]);
    const useCase = new GetPatientFunnelUseCase(db as unknown as Pool);

    const result = await useCase.execute({});

    expect(result.solicitantes).toBe(10);
    expect(result.admision).toBe(6);
    expect(result.agendadas).toBe(4);
    expect(result.vacantes).toBe(3);
    expect(result.byStatus).toEqual({ SOLICITANTE: 4, ADMISSION: 3, ACTIVE: 3 });
    expect(db.query).toHaveBeenCalledTimes(5);
  });

  it('sem from/to usa janela default de ~30 dias', async () => {
    const db = mockDb(0, 0, 0, 0, []);
    const useCase = new GetPatientFunnelUseCase(db as unknown as Pool);

    const result = await useCase.execute({});

    const from = new Date(result.period.from).getTime();
    const to = new Date(result.period.to).getTime();
    const days = (to - from) / (24 * 60 * 60 * 1000);
    expect(days).toBeCloseTo(30, 5);
  });

  it('respeita from/to explícitos no período retornado', async () => {
    const db = mockDb(0, 0, 0, 0, []);
    const useCase = new GetPatientFunnelUseCase(db as unknown as Pool);

    const from = '2026-07-01T00:00:00.000Z';
    const to = '2026-07-15T00:00:00.000Z';
    const result = await useCase.execute({ from, to });

    expect(result.period.from).toBe(from);
    expect(result.period.to).toBe(to);
  });

  it('sem country → country null e $3/$1 nulos nas queries', async () => {
    const db = mockDb(1, 1, 1, 1, []);
    const useCase = new GetPatientFunnelUseCase(db as unknown as Pool);

    const result = await useCase.execute({});

    expect(result.country).toBeNull();
    // 1ª query (solicitantes): params [from, to, null]
    expect(db.query.mock.calls[0][1][2]).toBeNull();
    // 5ª query (byStatus): params [null]
    expect(db.query.mock.calls[4][1]).toEqual([null]);
  });

  it('com country=BR → propaga BR para todas as queries', async () => {
    const db = mockDb(2, 1, 0, 0, [{ k: 'SOLICITANTE', count: 2 }]);
    const useCase = new GetPatientFunnelUseCase(db as unknown as Pool);

    const result = await useCase.execute({ country: 'BR' });

    expect(result.country).toBe('BR');
    expect(db.query.mock.calls[0][1][2]).toBe('BR'); // solicitantes
    expect(db.query.mock.calls[1][1][2]).toBe('BR'); // admision
    expect(db.query.mock.calls[2][1][2]).toBe('BR'); // agendadas
    expect(db.query.mock.calls[3][1][2]).toBe('BR'); // vacantes
    expect(db.query.mock.calls[4][1]).toEqual(['BR']); // byStatus
  });

  it('valida contrato Zod: rows vazias viram 0 sem quebrar', async () => {
    const db = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
    };
    const useCase = new GetPatientFunnelUseCase(db as unknown as Pool);

    const result = await useCase.execute({});

    expect(result.solicitantes).toBe(0);
    expect(result.admision).toBe(0);
    expect(result.agendadas).toBe(0);
    expect(result.vacantes).toBe(0);
    expect(result.byStatus).toEqual({});
  });
});
