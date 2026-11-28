/**
 * PgRateLimitStore contra POSTGRES REAL (tabela da migration 598). Sem API, sem Firebase, sem canal real.
 */
import { Pool } from 'pg';
import type { Options } from 'express-rate-limit';
import { PgRateLimitStore } from '../../src/shared/rateLimit/PgRateLimitStore';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const PREFIX = `e2e-rl-${Date.now()}`;

describe('PgRateLimitStore — Postgres real', () => {
  let pool: Pool;
  beforeAll(() => { pool = new Pool({ connectionString: DATABASE_URL }); });
  afterAll(async () => {
    await pool.query(`DELETE FROM rate_limit_counters WHERE key LIKE $1`, [`${PREFIX}%`]);
    await pool.end();
  });

  it('DUAS instâncias do store com o mesmo prefix somam na mesma chave', async () => {
    const a = new PgRateLimitStore(pool, `${PREFIX}-soma`);
    const b = new PgRateLimitStore(pool, `${PREFIX}-soma`);
    a.init({ windowMs: 60_000 } as Options);
    b.init({ windowMs: 60_000 } as Options);
    expect((await a.increment('uid-teste-soma')).totalHits).toBe(1);
    expect((await b.increment('uid-teste-soma')).totalHits).toBe(2);
    expect((await a.increment('uid-teste-soma')).totalHits).toBe(3);
  });

  it('janela vencida recomeça em 1', async () => {
    const store = new PgRateLimitStore(pool, `${PREFIX}-janela`);
    store.init({ windowMs: 60_000 } as Options);
    await store.increment('uid-teste-janela');
    await store.increment('uid-teste-janela');
    await pool.query(`UPDATE rate_limit_counters SET reset_at = NOW() - INTERVAL '1 second' WHERE key LIKE $1`, [`${PREFIX}-janela:%`]);
    expect((await store.increment('uid-teste-janela')).totalHits).toBe(1);
  });

  it('decrement baixa um e resetKey zera a chave', async () => {
    const store = new PgRateLimitStore(pool, `${PREFIX}-dec`);
    store.init({ windowMs: 60_000 } as Options);
    await store.increment('uid-teste-dec');
    await store.increment('uid-teste-dec');
    await store.decrement('uid-teste-dec');
    expect((await store.increment('uid-teste-dec')).totalHits).toBe(2);
    await store.resetKey('uid-teste-dec');
    expect((await store.increment('uid-teste-dec')).totalHits).toBe(1);
  });
});
