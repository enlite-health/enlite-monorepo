/**
 * txBoundPool (T-095-30): o "pool" que roda tudo na conexão da transação do chamador.
 * Prova: query() isolada por SAVEPOINT (falha não envenena a transação), BEGIN/COMMIT/ROLLBACK viram SAVEPOINT,
 * release() não devolve nada, e os GUCs LOCAL carimbados por uma etapa voltam ao valor anterior no "COMMIT".
 */
import type { PoolClient } from 'pg';
import { txBoundPool } from '../txBoundPool';

function fakeClient(failOn?: RegExp) {
  const sqls: string[] = [];
  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    sqls.push(params ? `${sql} ${JSON.stringify(params)}` : sql);
    if (failOn?.test(sql)) throw Object.assign(new Error('boom'), { code: '23505' });
    if (sql.includes('current_setting')) return { rows: [{ g0: 'uid-antes', g1: null, g2: null }] };
    return { rows: [{ ok: 1 }] };
  });
  return { client: { query, release: jest.fn() } as unknown as PoolClient, sqls, query };
}

describe('txBoundPool', () => {
  it('query(): cada comando roda num SAVEPOINT próprio e devolve o resultado', async () => {
    const f = fakeClient();
    const r = await txBoundPool(f.client).query('SELECT 1');
    expect(r).toEqual({ rows: [{ ok: 1 }] });
    expect(f.sqls).toEqual(['SAVEPOINT txb_1', 'SELECT 1', 'RELEASE SAVEPOINT txb_1']);
  });

  it('query() que falha: ROLLBACK TO do savepoint e o erro ORIGINAL sobe (a transação segue utilizável)', async () => {
    const f = fakeClient(/INSERT/);
    await expect(txBoundPool(f.client).query('INSERT x')).rejects.toMatchObject({ code: '23505' });
    expect(f.sqls).toEqual(['SAVEPOINT txb_1', 'INSERT x', 'ROLLBACK TO SAVEPOINT txb_1', 'RELEASE SAVEPOINT txb_1']);
  });

  it('connect(): BEGIN/COMMIT viram SAVEPOINT/RELEASE; os GUCs LOCAL voltam ao que eram antes do BEGIN; release() é no-op', async () => {
    const f = fakeClient();
    const c = await txBoundPool(f.client).connect();
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.current_uid', $1, true)`, ['talentum:manual']);
    await c.query('COMMIT');
    c.release();
    expect(f.sqls[0]).toBe('SAVEPOINT txb_1');
    expect(f.sqls[1]).toContain('current_setting');
    expect(f.sqls[3]).toBe('RELEASE SAVEPOINT txb_1');
    expect(f.sqls[4]).toContain("set_config('app.current_uid', $1, true)");
    expect(f.sqls[4]).toContain('["uid-antes","",""]');
    expect(f.sqls.some((s) => /^(BEGIN|COMMIT)$/.test(s))).toBe(false); // nunca BEGIN/COMMIT de verdade
    expect((f.client.release as jest.Mock)).not.toHaveBeenCalled();
  });

  it('connect(): ROLLBACK vira ROLLBACK TO + RELEASE do savepoint (e nunca ROLLBACK da transação externa)', async () => {
    const f = fakeClient();
    const c = await txBoundPool(f.client).connect();
    await c.query('BEGIN');
    await c.query('ROLLBACK');
    expect(f.sqls.slice(-2)).toEqual(['ROLLBACK TO SAVEPOINT txb_1', 'RELEASE SAVEPOINT txb_1']);
    expect(f.sqls).not.toContain('ROLLBACK');
  });
});
