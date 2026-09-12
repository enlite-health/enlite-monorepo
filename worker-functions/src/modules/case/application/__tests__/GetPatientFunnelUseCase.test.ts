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

    const result = await useCase.execute({ countries: ['AR', 'BR'] });

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

    const result = await useCase.execute({ countries: ['AR'] });

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
    const result = await useCase.execute({ from, to, countries: ['AR'] });

    expect(result.period.from).toBe(from);
    expect(result.period.to).toBe(to);
  });

  it('PR-9 (`lex` #9): `countries` (array do escopo) vira o predicado em TODAS as 5 queries — nunca "sem filtro"', async () => {
    const db = mockDb(1, 1, 1, 1, []);
    const useCase = new GetPatientFunnelUseCase(db as unknown as Pool);

    const result = await useCase.execute({ countries: ['AR', 'BR'] });

    // Escopo com 2 países: o contrato de saída (não tocado) ecoa null — "não é
    // um só" —, igual ao antigo "sem filtro" fazia; a diferença é que agora
    // SEMPRE existe um array explícito indo pro SQL, nunca um NULL solto.
    expect(result.country).toBeNull();
    expect(db.query.mock.calls[0][1][2]).toEqual(['AR', 'BR']); // solicitantes
    expect(db.query.mock.calls[1][1][2]).toEqual(['AR', 'BR']); // admision
    expect(db.query.mock.calls[2][1][2]).toEqual(['AR', 'BR']); // agendadas
    expect(db.query.mock.calls[3][1][2]).toEqual(['AR', 'BR']); // vacantes
    expect(db.query.mock.calls[4][1]).toEqual([['AR', 'BR']]); // byStatus

    for (let i = 0; i < 4; i++) {
      const sql: string = db.query.mock.calls[i][0];
      expect(sql).toContain('ANY($3::bpchar[])');
    }
    expect(db.query.mock.calls[4][0]).toContain('ANY($1::bpchar[])');
  });

  it('com countries=[BR] (país único resolvido) → propaga BR sozinho, e o contrato de saída ecoa o país', async () => {
    const db = mockDb(2, 1, 0, 0, [{ k: 'SOLICITANTE', count: 2 }]);
    const useCase = new GetPatientFunnelUseCase(db as unknown as Pool);

    const result = await useCase.execute({ countries: ['BR'] });

    expect(result.country).toBe('BR');
    expect(db.query.mock.calls[0][1][2]).toEqual(['BR']); // solicitantes
    expect(db.query.mock.calls[1][1][2]).toEqual(['BR']); // admision
    expect(db.query.mock.calls[2][1][2]).toEqual(['BR']); // agendadas
    expect(db.query.mock.calls[3][1][2]).toEqual(['BR']); // vacantes
    expect(db.query.mock.calls[4][1]).toEqual([['BR']]); // byStatus
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

    const result = await useCase.execute({ countries: ['AR'] });

    expect(result.solicitantes).toBe(0);
    expect(result.admision).toBe(0);
    expect(result.agendadas).toBe(0);
    expect(result.vacantes).toBe(0);
    expect(result.byStatus).toEqual({});
  });
});
