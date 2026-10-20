/**
 * contractedServiceAuthorizationRead — a autorização corrente é lida pelo `asOf` do chamador (dia de operação do país),
 * nunca pelo relógio do banco, e a vigência volta pelo wire (`toWire`).
 */
import { fetchCurrentAuthorizations } from '../contractedServiceAuthorizationRead';

function fakeQ(rows: any[] = []) {
  return { query: jest.fn().mockResolvedValue({ rows }) };
}

describe('fetchCurrentAuthorizations', () => {
  it('asOf: passa o asOf como $2 e o SQL lê valid @> $2::date (nunca CURRENT_DATE)', async () => {
    const q = fakeQ();
    await fetchCurrentAuthorizations(q, ['svc-1'], '2024-03-09');
    const [sql, params] = q.query.mock.calls[0];
    expect(params).toEqual([['svc-1'], '2024-03-09']);
    expect(sql).toContain('$2::date');
    expect(sql).not.toMatch(/CURRENT_DATE/);
  });

  it('sem ids não consulta e devolve Map vazio', async () => {
    const q = fakeQ();
    const out = await fetchCurrentAuthorizations(q, [], '2024-03-09');
    expect(q.query).not.toHaveBeenCalled();
    expect(out.size).toBe(0);
  });

  it('converte valid::text em validFrom e validTo inclusivo', async () => {
    const q = fakeQ([{ contracted_service_id: 'svc-1', id: 'a1', hours: '120', valid: '[2026-01-01,2027-01-01)' }]);
    const out = await fetchCurrentAuthorizations(q, ['svc-1'], '2026-06-01');
    expect(out.get('svc-1')).toEqual({ id: 'a1', hours: 120, validFrom: '2026-01-01', validTo: '2026-12-31' });
  });

  it('lê só a corrente: o SQL tem superseded_at IS NULL', async () => {
    const q = fakeQ();
    await fetchCurrentAuthorizations(q, ['svc-1'], '2026-06-01');
    expect(q.query.mock.calls[0][0]).toContain('superseded_at IS NULL');
  });
});
