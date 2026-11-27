import { createHash } from 'crypto';
import type { Options } from 'express-rate-limit';
import { PgRateLimitStore } from '../PgRateLimitStore';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const UID = 'uid-teste-001';

function poolDuble(rows: unknown[] = []) {
  const query = jest.fn().mockResolvedValue({ rows });
  return { pool: { query } as never, query };
}

describe('PgRateLimitStore', () => {
  it('a chave enviada ao pool é `prefix:` + 64 hex e NÃO contém a chave crua', async () => {
    const { pool, query } = poolDuble([{ hits: 1, reset_at: new Date() }]);
    const store = new PgRateLimitStore(pool, 'pv-start-uid');
    await store.increment(`uid:${UID}`);
    const key = query.mock.calls[0][1][0] as string;
    expect(key).toMatch(/^pv-start-uid:[0-9a-f]{64}$/);
    expect(key).not.toContain(UID);
    expect(key).toBe(`pv-start-uid:${sha(`uid:${UID}`)}`);
  });

  it('increment devolve { totalHits, resetTime } do RETURNING e usa a janela do init', async () => {
    const reset = new Date('2030-01-01T00:00:00Z');
    const { pool, query } = poolDuble([{ hits: 3, reset_at: reset }]);
    const store = new PgRateLimitStore(pool, 'x');
    store.init({ windowMs: 15 * 60 * 1000 } as Options);
    await expect(store.increment('k')).resolves.toEqual({ totalHits: 3, resetTime: reset });
    expect(query.mock.calls[0][1][1]).toBe(900);
    expect(query.mock.calls[0][0]).toContain('ON CONFLICT (key) DO UPDATE');
  });

  it('erro do pool sobe (falha fechada)', async () => {
    const query = jest.fn().mockRejectedValue(new Error('db fora'));
    const store = new PgRateLimitStore({ query } as never, 'x');
    await expect(store.increment('k')).rejects.toThrow('db fora');
  });

  it('decrement e resetKey usam a mesma chave com hash', async () => {
    const { pool, query } = poolDuble();
    const store = new PgRateLimitStore(pool, 'p');
    await store.decrement('k');
    await store.resetKey('k');
    expect(query.mock.calls[0][0]).toContain('GREATEST(hits - 1, 0)');
    expect(query.mock.calls[1][0]).toContain('DELETE FROM rate_limit_counters');
    expect(query.mock.calls[0][1]).toEqual([`p:${sha('k')}`]);
    expect(query.mock.calls[1][1]).toEqual([`p:${sha('k')}`]);
  });

  it('prefixes distintos geram chaves distintas para o mesmo uid', async () => {
    const a = poolDuble([{ hits: 1, reset_at: new Date() }]);
    const b = poolDuble([{ hits: 1, reset_at: new Date() }]);
    await new PgRateLimitStore(a.pool, 'a').increment('k');
    await new PgRateLimitStore(b.pool, 'b').increment('k');
    expect(a.query.mock.calls[0][1][0]).not.toBe(b.query.mock.calls[0][1][0]);
  });
});
