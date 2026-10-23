import { SubstitutionRequestWriter } from '../SubstitutionRequestWriter';

describe('SubstitutionRequestWriter (migration 548)', () => {
  it('insert: UMA query no client, só INSERT no cabeçalho, sem country (o trigger herda), devolve o id', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [{ id: 'req-1' }], rowCount: 1 }) };
    const r = await new SubstitutionRequestWriter().insert(client as never, {
      serviceId: 's-1',
      outgoingWorkerId: 'w-out',
      reasonCode: 'OTHER',
      actorUid: 'staff:u-1',
    });
    expect(r).toEqual({ id: 'req-1' });
    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, params] = client.query.mock.calls[0];
    expect(String(sql)).toMatch(/^\s*INSERT INTO patient_itinerary_substitution_request/);
    expect(String(sql)).not.toMatch(/UPDATE|DELETE|country|now\(\)/);
    expect(params).toEqual(['s-1', 'w-out', 'OTHER', 'staff:u-1']);
  });

  it('markUndone: UMA query, só carimba undone_at/by de pedido ainda NÃO desfeito (WHERE undone_at IS NULL), devolve o rowCount', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }) };
    expect(await new SubstitutionRequestWriter().markUndone(client as never, 'req-1', 'staff:u-1')).toBe(1);
    const [sql, params] = client.query.mock.calls[0];
    expect(String(sql)).toMatch(/UPDATE patient_itinerary_substitution_request SET undone_at = now\(\), undone_by = \$2 WHERE id = \$1 AND undone_at IS NULL/);
    expect(String(sql)).not.toMatch(/DELETE/);
    expect(params).toEqual(['req-1', 'staff:u-1']);
    const jaDesfeito = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
    expect(await new SubstitutionRequestWriter().markUndone(jaDesfeito as never, 'req-1', 'u')).toBe(0);
    const semContagem = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    expect(await new SubstitutionRequestWriter().markUndone(semContagem as never, 'req-1', 'u')).toBe(0);
  });

  it('erro do banco sobe cru (quem chama decide; a transação desfaz)', async () => {
    const boom = Object.assign(new Error('fk'), { code: '23503' });
    const client = { query: jest.fn().mockRejectedValue(boom) };
    await expect(
      new SubstitutionRequestWriter().insert(client as never, { serviceId: 's', outgoingWorkerId: 'w', reasonCode: 'X', actorUid: 'u' }),
    ).rejects.toBe(boom);
  });
});
