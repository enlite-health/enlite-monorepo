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

  it('erro do banco sobe cru (quem chama decide; a transação desfaz)', async () => {
    const boom = Object.assign(new Error('fk'), { code: '23503' });
    const client = { query: jest.fn().mockRejectedValue(boom) };
    await expect(
      new SubstitutionRequestWriter().insert(client as never, { serviceId: 's', outgoingWorkerId: 'w', reasonCode: 'X', actorUid: 'u' }),
    ).rejects.toBe(boom);
  });
});
