import { ReadonlyDbQueryService, HARD_MAX_ROWS } from '../ReadonlyDbQueryService';

function makePool(rows: Array<Record<string, unknown>> = []) {
  const client = {
    query: jest.fn().mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.startsWith('SELECT * FROM (')) {
        return Promise.resolve({ rows });
      }
      return Promise.resolve({ rows: [] });
    }),
    release: jest.fn(),
  };
  const pool = { connect: jest.fn().mockResolvedValue(client) };
  return { pool, client };
}

describe('ReadonlyDbQueryService', () => {
  it('roda SELECT dentro de transação READ ONLY com timeout e LIMIT envolvente', async () => {
    const { pool, client } = makePool([{ total: 42 }]);
    const service = new ReadonlyDbQueryService(pool as never);

    const result = await service.run('SELECT COUNT(*) AS total FROM workers;', 50);

    expect(result).toEqual({ rows: [{ total: 42 }], rowCount: 1, truncated: false });
    const calls = (client.query.mock.calls as [string][]).map(([sql]) => sql);
    expect(calls[0]).toBe('BEGIN TRANSACTION READ ONLY');
    expect(calls[1]).toContain('statement_timeout');
    expect(calls[2]).toBe('SELECT * FROM (SELECT COUNT(*) AS total FROM workers) AS mcp_q LIMIT 51');
    expect(calls[3]).toBe('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });

  it('aceita WITH (CTE)', async () => {
    const { pool } = makePool([]);
    const service = new ReadonlyDbQueryService(pool as never);
    await expect(
      service.run('WITH x AS (SELECT 1 AS n) SELECT * FROM x'),
    ).resolves.toMatchObject({ rowCount: 0 });
  });

  it('rejeita não-SELECT e multi-statement', async () => {
    const { pool } = makePool();
    const service = new ReadonlyDbQueryService(pool as never);
    await expect(service.run('DELETE FROM workers')).rejects.toThrow(/Only SELECT\/WITH/);
    await expect(service.run('UPDATE workers SET status = 1')).rejects.toThrow(/Only SELECT\/WITH/);
    await expect(service.run('SELECT 1; DROP TABLE workers')).rejects.toThrow(/single statement/);
    await expect(service.run('   ;  ')).rejects.toThrow(/Empty SQL/);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('marca truncated e corta em maxRows (cap em HARD_MAX_ROWS)', async () => {
    const manyRows = Array.from({ length: 3 }, (_, i) => ({ i }));
    const { pool } = makePool(manyRows);
    const service = new ReadonlyDbQueryService(pool as never);

    const result = await service.run('SELECT i FROM t', 2);
    expect(result.truncated).toBe(true);
    expect(result.rowCount).toBe(2);

    const capped = await service.run('SELECT i FROM t', 9999);
    expect(capped).toBeDefined();
    expect(HARD_MAX_ROWS).toBe(200);
  });

  it('erro do banco → ROLLBACK e release', async () => {
    const client = {
      query: jest.fn().mockImplementation((sql: string) => {
        if (sql.startsWith('SELECT * FROM (')) return Promise.reject(new Error('permission denied'));
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn(),
    };
    const pool = { connect: jest.fn().mockResolvedValue(client) };
    const service = new ReadonlyDbQueryService(pool as never);

    await expect(service.run('SELECT * FROM secret_table')).rejects.toThrow('permission denied');
    const calls = (client.query.mock.calls as [string][]).map(([sql]) => sql);
    expect(calls).toContain('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });
});
