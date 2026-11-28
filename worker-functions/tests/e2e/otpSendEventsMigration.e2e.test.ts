/**
 * Migration 598 (otp_send_events + rate_limit_counters) contra POSTGRES REAL. Sem API, sem Firebase, sem canal real.
 * Rodar como `enlite_app` (o executor das migrations em prd), não como superuser.
 */
import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const MIGRATION_SQL = path.join(__dirname, '..', '..', 'migrations', '598_otp_send_events_e_rate_limit_counters.sql');
const ROLLBACK_SQL = path.join(__dirname, '..', '..', 'migrations', 'pending', 'ROLLBACK_598_otp_send_events_e_rate_limit_counters.sql');

describe('migration 598 — otp_send_events e rate_limit_counters', () => {
  let pool: Pool;
  beforeAll(() => { pool = new Pool({ connectionString: DATABASE_URL }); });
  afterAll(async () => { await pool.end(); });

  it('roda 2x sem erro (idempotente) e as duas tabelas existem', async () => {
    const sql = fs.readFileSync(MIGRATION_SQL, 'utf8');
    await pool.query(sql);
    await pool.query(sql);
    const { rows } = await pool.query<{ a: string | null; b: string | null }>(
      `SELECT to_regclass('public.otp_send_events') AS a, to_regclass('public.rate_limit_counters') AS b`,
    );
    expect(rows[0].a).not.toBeNull();
    expect(rows[0].b).not.toBeNull();
  });

  it('adapter own com target_worker_id NÃO nulo viola o CHECK otp_send_events_target_por_adapter', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const w = await client.query<{ id: string }>(`INSERT INTO workers (auth_uid) VALUES ($1) RETURNING id`, [`uid-teste-${Date.now()}`]);
      await expect(
        client.query(
          `INSERT INTO otp_send_events (challenge_id, adapter, purpose, requester_hash, target_worker_id, suppressed)
           VALUES ('c-own', 'own', 'claim', $1, $2, false)`,
          ['a'.repeat(64), w.rows[0].id],
        ),
      ).rejects.toThrow(/otp_send_events_target_por_adapter/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('o CHECK aceita own sem ficha e verify com ficha, e recusa verify sem ficha', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const w = await client.query<{ id: string }>(`INSERT INTO workers (auth_uid) VALUES ($1) RETURNING id`, [`uid-teste-${Date.now()}`]);
      const insert = (adapter: string, target: string | null) =>
        client.query(
          `INSERT INTO otp_send_events (challenge_id, adapter, purpose, requester_hash, target_worker_id, suppressed)
           VALUES ('c-x', $1, 'link', $2, $3, false)`,
          [adapter, 'b'.repeat(64), target],
        );
      await insert('own', null);
      await insert('verify', w.rows[0].id);
      await client.query('SAVEPOINT recusa');
      await expect(insert('verify', null)).rejects.toThrow(/otp_send_events_target_por_adapter/);
      await client.query('ROLLBACK TO SAVEPOINT recusa');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('o rollback derruba as duas tabelas', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(fs.readFileSync(ROLLBACK_SQL, 'utf8').replace(/^\s*BEGIN;|COMMIT;\s*$/gm, ''));
      const { rows } = await client.query<{ a: string | null; b: string | null }>(
        `SELECT to_regclass('public.otp_send_events') AS a, to_regclass('public.rate_limit_counters') AS b`,
      );
      expect(rows[0].a).toBeNull();
      expect(rows[0].b).toBeNull();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
