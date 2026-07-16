import { DeactivateWorkerAccountUseCase } from '../DeactivateWorkerAccountUseCase';

function makeDeps(statusRow: { status: string } | null) {
  const client = {
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
    release: jest.fn(),
  };
  const db = {
    query: jest
      .fn()
      .mockResolvedValue({ rows: statusRow ? [statusRow] : [], rowCount: statusRow ? 1 : 0 }),
    connect: jest.fn().mockResolvedValue(client),
  };
  const optOut = { execute: jest.fn().mockResolvedValue({ ok: true, workerId: 'w1' }) };
  const uc = new DeactivateWorkerAccountUseCase(db as never, optOut as never);
  return { uc, db, client, optOut };
}

const WID = '6b5bfff2-c702-4037-bfb3-004a37b35cb7';

describe('DeactivateWorkerAccountUseCase', () => {
  it('worker inexistente → ok:false, não desativa nem faz opt-out', async () => {
    const { uc, db, optOut } = makeDeps(null);
    const res = await uc.execute({ workerId: WID });
    expect(res).toEqual({ ok: false, alreadyDisabled: false });
    expect(db.connect).not.toHaveBeenCalled();
    expect(optOut.execute).not.toHaveBeenCalled();
  });

  it('REGISTERED → transação com auditoria (app.current_uid) + UPDATE DISABLED + opt-out', async () => {
    const { uc, client, optOut } = makeDeps({ status: 'REGISTERED' });
    const res = await uc.execute({ workerId: WID, source: 'luz_conversation' });
    expect(res).toEqual({ ok: true, alreadyDisabled: false });
    const sqls = client.query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes('BEGIN'))).toBe(true);
    expect(sqls.some((s) => s.includes('app.current_uid'))).toBe(true);
    expect(sqls.some((s) => s.includes("status = 'DISABLED'"))).toBe(true);
    expect(sqls.some((s) => s.includes('COMMIT'))).toBe(true);
    expect(optOut.execute).toHaveBeenCalledWith({
      workerId: WID,
      reason: 'user_request',
      source: 'luz_conversation',
    });
  });

  it('já DISABLED → idempotente (não abre transação de UPDATE, mas garante o opt-out)', async () => {
    const { uc, db, optOut } = makeDeps({ status: 'DISABLED' });
    const res = await uc.execute({ workerId: WID });
    expect(res).toEqual({ ok: true, alreadyDisabled: true });
    expect(db.connect).not.toHaveBeenCalled();
    expect(optOut.execute).toHaveBeenCalledTimes(1);
  });
});
