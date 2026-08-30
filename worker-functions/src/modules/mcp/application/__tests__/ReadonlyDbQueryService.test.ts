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

  it('C2 (D211.2): query que toca emergency_instructions é recusada antes de abrir transação', async () => {
    const { pool, client } = makePool();
    const service = new ReadonlyDbQueryService(pool as never);
    await expect(service.run('SELECT emergency_instructions FROM patients', 10)).rejects.toThrow(/restricted clinical column/);
    await expect(service.run('select p.EMERGENCY_INSTRUCTIONS_updated_by from patients p', 10)).rejects.toThrow(/restricted clinical column/);
    expect(pool.connect).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
  });
});

describe('ReadonlyDbQueryService — projeção de linha inteira em tabela clínica (D216, defesa em profundidade)', () => {
  const recusadas: Array<[string, string]> = [
    ['select *', 'select * from patients'],
    ['SELECT DISTINCT *', 'SELECT DISTINCT * FROM patients WHERE country = \'AR\''],
    ['alias.*', 'select p.* from patients p'],
    ['* depois de coluna', 'select id, * from patients'],
    ['subselect com *', 'select count(1) from (select * from patients) s'],
    ['patient_* com *', 'select * from patient_responsibles'],
    ['to_jsonb(p)', 'select to_jsonb(p) from patients p'],
    ['to_json(p)', 'select to_json(p) from patients p'],
    ['row_to_json(patients)', 'select row_to_json(patients) from patients'],
    ['json_agg(p)', 'select json_agg(p) from patients p'],
    ['jsonb_agg(p)', 'select jsonb_agg(p) from patients p'],
    ['hstore(p)', 'select hstore(p) from patients p'],
    ['CTE que toca patients', 'with p as (select * from patients) select id from p'],
  ];
  it.each(recusadas)('%s → recusada antes de abrir transação', async (_nome, sql) => {
    const { pool, client } = makePool();
    const service = new ReadonlyDbQueryService(pool as never);
    await expect(service.run(sql)).rejects.toThrow(/Whole-row projection/);
    expect(pool.connect).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
  });

  const permitidas: Array<[string, string]> = [
    ['colunas nomeadas', 'select id, status from patients'],
    ['count(*) — contagem é item 1', 'SELECT count(*) FROM patients'],
    ['count( * ) com espaços', 'select count( * ) from patient_responsibles'],
    ['multiplicação não é projeção', 'select id, dependency_level, 2 * 3 as x from patients'],
    ['patients_ro é a view sem texto clínico', 'select * from patients_ro'],
    ['tabela não clínica com *', 'select * from workers'],
    ['to_jsonb em tabela não clínica', 'select to_jsonb(w) from workers w'],
  ];
  it.each(permitidas)('%s → passa', async (_nome, sql) => {
    const { pool } = makePool([]);
    const service = new ReadonlyDbQueryService(pool as never);
    await expect(service.run(sql)).resolves.toMatchObject({ rowCount: 0 });
  });
});
