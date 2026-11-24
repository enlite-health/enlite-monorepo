/**
 * T-F3c-107 — migration 592 (otp_challenges, D758) contra POSTGRES REAL. Sem API, sem Firebase, sem canal real.
 * Rodar como `enlite_app` (o executor das migrations em prd), não como superuser.
 */
import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const ROLLBACK_SQL = path.join(__dirname, '..', '..', 'migrations', 'pending', 'ROLLBACK_592_otp_challenges.sql');

describe('migration 592 — otp_challenges', () => {
  let pool: Pool;
  beforeAll(() => { pool = new Pool({ connectionString: DATABASE_URL }); });
  afterAll(async () => { await pool.end(); });

  it('T-F3c-107 a tabela e as colunas do desenho existem', async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'otp_challenges'`,
    );
    expect(rows.map((r) => r.column_name).sort()).toEqual(
      ['attempts', 'code_hmac', 'created_at', 'expires_at', 'id', 'phone_e164', 'purpose', 'send_status', 'status', 'twilio_sid', 'worker_id'].sort(),
    );
  });

  it('T-F3c-107 code_hmac e phone_e164 são NOT NULL', async () => {
    const { rows } = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'otp_challenges' AND column_name IN ('code_hmac', 'phone_e164')`,
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.is_nullable === 'NO')).toBe(true);
  });

  it('T-F3c-107 o rollback derruba a tabela', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(fs.readFileSync(ROLLBACK_SQL, 'utf8'));
      const { rows } = await client.query<{ t: string | null }>(`SELECT to_regclass('public.otp_challenges') AS t`);
      expect(rows[0].t).toBeNull();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
