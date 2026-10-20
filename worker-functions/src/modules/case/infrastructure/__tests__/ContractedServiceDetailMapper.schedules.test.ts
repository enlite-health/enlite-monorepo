/**
 * fetchServiceSchedules — dono único da agenda vigente em `asOf` (ficha e rota chamam a MESMA).
 */
import { fetchServiceSchedules } from '../ContractedServiceDetailMapper';

function fakeQ(rows: any[] = []) {
  return { query: jest.fn().mockResolvedValue({ rows }) };
}

describe('fetchServiceSchedules', () => {
  it('agenda asOf: passa o asOf como $2::date (nunca CURRENT_DATE) e devolve a agenda do id', async () => {
    const schedule = [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00', durationMinutes: 240 }];
    const q = fakeQ([{ id: 's1', schedule }]);
    const out = await fetchServiceSchedules(q, ['s1'], '2024-03-09');
    const [sql, params] = q.query.mock.calls[0];
    expect(params).toEqual([['s1'], '2024-03-09']);
    expect(sql).toContain('$2::date');
    expect(sql).not.toMatch(/CURRENT_DATE/);
    expect(out.get('s1')).toEqual(schedule);
  });

  it('lote sem buraco: 3 ids, 1 sem faixa → Map com 3 chaves e a 3ª null', async () => {
    const q = fakeQ([
      { id: 's1', schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00', durationMinutes: 240 }] },
      { id: 's2', schedule: null },
    ]);
    const out = await fetchServiceSchedules(q, ['s1', 's2', 's3'], '2024-03-09');
    expect([...out.keys()]).toEqual(['s1', 's2', 's3']);
    expect(out.get('s3')).toBeNull();
  });

  it('sem ids: não consulta e devolve Map vazio', async () => {
    const q = fakeQ();
    const out = await fetchServiceSchedules(q, [], '2024-03-09');
    expect(q.query).not.toHaveBeenCalled();
    expect(out.size).toBe(0);
  });
});
