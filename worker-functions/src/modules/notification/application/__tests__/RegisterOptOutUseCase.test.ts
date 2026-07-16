import { RegisterOptOutUseCase } from '../RegisterOptOutUseCase';

function makeDb(queryImpl: jest.Mock) {
  return { query: queryImpl } as never;
}

describe('RegisterOptOutUseCase', () => {
  it('resolve por phone → SELECT id + INSERT (fonte única, source do canal)', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: 'w1' }] }) // SELECT id FROM workers WHERE phone
      .mockResolvedValueOnce({ rows: [] }); // INSERT
    const uc = new RegisterOptOutUseCase(makeDb(query));

    const res = await uc.execute({ phone: 'whatsapp:+5491112345678', source: 'whatsapp_inbound' });

    expect(res).toEqual({ ok: true, workerId: 'w1' });
    // phone normalizado (sem whatsapp:) na resolução
    expect(query.mock.calls[0][1]).toEqual(['+5491112345678']);
    // INSERT com os 4 params + reason default
    expect(query.mock.calls[1][0]).toContain('INSERT INTO messaging_opt_out');
    expect(query.mock.calls[1][1]).toEqual([
      'w1',
      '+5491112345678',
      'user_request',
      'whatsapp_inbound',
    ]);
  });

  it('resolve por workerId → SELECT phone + INSERT (canal Luz)', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ phone: '+5491100000000' }] }) // SELECT phone FROM workers WHERE id
      .mockResolvedValueOnce({ rows: [] }); // INSERT
    const uc = new RegisterOptOutUseCase(makeDb(query));

    const res = await uc.execute({ workerId: 'w9', source: 'luz_conversation' });

    expect(res).toEqual({ ok: true, workerId: 'w9' });
    expect(query.mock.calls[1][1]).toEqual([
      'w9',
      '+5491100000000',
      'user_request',
      'luz_conversation',
    ]);
  });

  it('phone desconhecido → ok:false, não faz INSERT', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [] }); // SELECT sem match
    const uc = new RegisterOptOutUseCase(makeDb(query));

    const res = await uc.execute({ phone: '+000', source: 'whatsapp_inbound' });

    expect(res).toEqual({ ok: false, workerId: null });
    expect(query).toHaveBeenCalledTimes(1); // só o SELECT, nunca o INSERT
  });
});
