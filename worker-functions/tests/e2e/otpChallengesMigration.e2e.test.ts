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
// A 594 (celular verificado) tem FK para otp_challenges: o rollback segue a ordem inversa (594 antes da 592).
const ROLLBACK_594_SQL = path.join(__dirname, '..', '..', 'migrations', 'pending', 'ROLLBACK_594_phone_verification.sql');

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
      await client.query(fs.readFileSync(ROLLBACK_594_SQL, 'utf8'));
      await client.query(fs.readFileSync(ROLLBACK_SQL, 'utf8'));
      const { rows } = await client.query<{ t: string | null }>(`SELECT to_regclass('public.otp_challenges') AS t`);
      expect(rows[0].t).toBeNull();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('T-F3c-107 o CHECK de purpose aceita claim, link e phone_verify e recusa outro valor', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const w = await client.query<{ id: string }>(`INSERT INTO workers (auth_uid) VALUES ($1) RETURNING id`, [`otp-mig-${Date.now()}`]);
      const insert = (purpose: string) =>
        client.query(
          `INSERT INTO otp_challenges (id, worker_id, purpose, phone_e164, code_hmac, expires_at, status)
           VALUES (gen_random_uuid(), $1, $2, '+5491100000000', 'aa', NOW() + INTERVAL '10 minutes', 'canceled')`,
          [w.rows[0].id, purpose],
        );
      for (const ok of ['claim', 'link', 'phone_verify']) await insert(ok);
      await client.query('SAVEPOINT recusa');
      await expect(insert('marketing')).rejects.toThrow(/otp_challenges_purpose_check/);
      await client.query('ROLLBACK TO SAVEPOINT recusa');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('T-F3c-107 os 3 índices dos limites de envio e da busca por twilio_sid existem (pg_indexes) e o planner usa o de telefone', async () => {
    const { rows } = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'otp_challenges' AND indexname LIKE 'idx_otp_challenges_%'`,
    );
    expect(rows.map((r) => r.indexname).sort()).toEqual(
      ['idx_otp_challenges_phone_created', 'idx_otp_challenges_twilio_sid', 'idx_otp_challenges_worker_created'],
    );
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const plan = await client.query<Record<string, string>>(
        `EXPLAIN SELECT 1 FROM otp_challenges WHERE phone_e164 = '+5491100000000' AND created_at > NOW() - INTERVAL '24 hours'`,
      );
      expect(plan.rows.map((r) => r['QUERY PLAN']).join('\n')).toMatch(/idx_otp_challenges_phone_created/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
