/**
 * T-F3c-130 — migration 594 (colunas phone_verified_*, CHECKs e índices únicos parciais) contra POSTGRES REAL, como `enlite_app`.
 */
import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import { novaFicha } from './helpers/phoneVerificationFixtures';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const ROLLBACK_SQL = path.join(__dirname, '..', '..', 'migrations', 'pending', 'ROLLBACK_594_phone_verification.sql');

describe('migration 594 — colunas do celular verificado', () => {
  let pool: Pool;
  beforeAll(() => { pool = new Pool({ connectionString: DATABASE_URL }); });
  afterAll(async () => { await pool.end(); });

  it('T-F3c-130 as 4 colunas phone_verified_* existem em workers, todas nuláveis', async () => {
    const { rows } = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'workers' AND column_name LIKE 'phone_verified_%'`,
    );
    expect(rows.map((r) => r.column_name).sort()).toEqual(
      ['phone_verified_at', 'phone_verified_method', 'phone_verified_normalized', 'phone_verified_otp_challenge_id'],
    );
    expect(rows.every((r) => r.is_nullable === 'YES')).toBe(true);
  });

  it('T-F3c-130 UPDATE com só 2 das 3 colunas obrigatórias falha (CHECK tudo-ou-nada)', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const w = await novaFicha(client);
      await expect(
        client.query(`UPDATE workers SET phone_verified_normalized = phone_normalized, phone_verified_at = now() WHERE id = $1`, [w.id]),
      ).rejects.toThrow(/workers_phone_verified_all_or_nothing/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('T-F3c-130 phone_verified_method fora da lista falha', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const w = await novaFicha(client);
      await client.query('SAVEPOINT s');
      await expect(
        client.query(
          `UPDATE workers SET phone_verified_normalized = phone_normalized, phone_verified_at = now(), phone_verified_method = 'sms' WHERE id = $1`,
          [w.id],
        ),
      ).rejects.toThrow(/workers_phone_verified_method_check/);
      await client.query('ROLLBACK TO SAVEPOINT s');
      for (const ok of ['otp_whatsapp_template', 'otp_verify_whatsapp']) {
        await client.query(
          `UPDATE workers SET phone_verified_normalized = phone_normalized, phone_verified_at = now(), phone_verified_method = $2 WHERE id = $1`,
          [w.id, ok],
        );
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('T-F3c-130 o rollback derruba as colunas e os 2 índices únicos parciais', async () => {
    const idx = `SELECT count(*)::int AS n FROM pg_indexes WHERE indexname IN ('uq_workers_phone_verified_now','uq_workers_phone_verified_otp_challenge')`;
    expect((await pool.query<{ n: number }>(idx)).rows[0].n).toBe(2);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(fs.readFileSync(ROLLBACK_SQL, 'utf8'));
      expect((await client.query<{ n: number }>(idx)).rows[0].n).toBe(0);
      const cols = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'workers' AND column_name LIKE 'phone_verif%'`,
      );
      expect(cols.rows[0].n).toBe(0);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
