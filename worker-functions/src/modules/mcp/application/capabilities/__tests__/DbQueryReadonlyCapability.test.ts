import { DbQueryReadonlyCapability } from '../DbQueryReadonlyCapability';

describe('DbQueryReadonlyCapability', () => {
  const okResult = { rows: [{ n: 1 }], rowCount: 1, truncated: false };

  function makeCap() {
    const service = { run: jest.fn().mockResolvedValue(okResult) };
    return { cap: new DbQueryReadonlyCapability(service as never), service };
  }

  it('NAME db.query.readonly e delegação com maxRows', async () => {
    expect(DbQueryReadonlyCapability.NAME).toBe('db.query.readonly');
    const { cap, service } = makeCap();
    await expect(
      cap.execute({ sql: 'SELECT COUNT(*) FROM workers', maxRows: 10 }),
    ).resolves.toEqual(okResult);
    expect(service.run).toHaveBeenCalledWith('SELECT COUNT(*) FROM workers', 10);
  });

  it('rejeita sql ausente/curto e maxRows fora do range', async () => {
    const { cap } = makeCap();
    await expect(cap.execute({})).rejects.toThrow();
    await expect(cap.execute({ sql: 'SELECT' })).rejects.toThrow();
    await expect(cap.execute({ sql: 'SELECT 1 FROM t', maxRows: 500 })).rejects.toThrow();
  });
});
