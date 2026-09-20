/**
 * account-type-boundary — D294: a fronteira staff × prestador é `users.account_type`
 * (migration 414) e o claim `account_type`; `role` é só ponte.
 *
 * Postgres real (o trigger, o CHECK, o backfill) + HTTP real contra a API de pé em
 * USE_MOCK_AUTH (o token mock leva `role` e/ou `account_type`, como o claim levaria).
 * Condições do `lex` (07/09) provadas aqui: C1 allowlist no SQL · C3 o UPDATE de
 * `role` também deriva (inclusive via `change_user_role`) · C5 sem tipo e sem papel
 * não é staff · C6 `patient` NÃO entra no CHECK.
 */
import axios, { AxiosInstance } from 'axios';
import { Pool } from 'pg';

const API_URL = process.env.API_URL || 'http://localhost:8080';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const TENANT = '00000000-0000-0000-0000-000000000001';
const PREFIXO = 'e2e-acct-type-';

function tokenMock(payload: Record<string, unknown>): string {
  return `Bearer mock_${Buffer.from(JSON.stringify(payload)).toString('base64')}`;
}

describe('users.account_type — a fronteira staff × prestador (migration 414, D294)', () => {
  let pool: Pool;
  let api: AxiosInstance;

  const limpar = () => pool.query(`DELETE FROM users WHERE firebase_uid LIKE $1`, [`${PREFIXO}%`]);

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    api = axios.create({ baseURL: API_URL, validateStatus: () => true });
    await limpar();
  });
  afterAll(async () => {
    await limpar();
    await pool.end();
  });

  describe('esquema', () => {
    it('a coluna existe, é NOT NULL, tem CHECK (staff|worker) e o backfill fechou (0 sem tipo)', async () => {
      const col = await pool.query(
        `SELECT is_nullable FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'account_type'`,
      );
      expect(col.rows[0]?.is_nullable).toBe('NO');
      const semTipo = await pool.query(`SELECT count(*)::int AS n FROM users WHERE account_type IS NULL`);
      expect(semTipo.rows[0].n).toBe(0);
      const tipos = await pool.query(`SELECT DISTINCT account_type FROM users ORDER BY 1`);
      for (const r of tipos.rows) expect(['staff', 'worker']).toContain(r.account_type);
    });

    it('lex C6: `patient` NÃO entra — o CHECK recusa', async () => {
      await expect(
        pool.query(
          `INSERT INTO users (firebase_uid, email, role, account_type, tenant_id) VALUES ($1, $2, 'admin', 'patient', $3)`,
          [`${PREFIXO}patient`, `${PREFIXO}patient@e2e.local`, TENANT],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('a ponte no banco (trigger + account_type_for_role)', () => {
    it.each([
      ['admin', 'staff'],
      ['recruiter', 'staff'],
      ['community_manager', 'staff'],
      ['worker', 'worker'],
    ])('INSERT só com role=%s → account_type=%s (seeds e scripts antigos continuam válidos)', async (role, esperado) => {
      const uid = `${PREFIXO}ins-${role}`;
      await pool.query(`INSERT INTO users (firebase_uid, email, role, tenant_id) VALUES ($1, $2, $3, $4)`, [uid, `${uid}@e2e.local`, role, TENANT]);
      const r = await pool.query(`SELECT account_type FROM users WHERE firebase_uid = $1`, [uid]);
      expect(r.rows[0].account_type).toBe(esperado);
    });

    it.each([['manager'], ['support'], ['client']])('lex C1: papel legado %s sem tipo declarado → a linha NÃO nasce (levanta, nunca vira staff)', async (role) => {
      const uid = `${PREFIXO}legado-${role}`;
      await expect(
        pool.query(`INSERT INTO users (firebase_uid, email, role, tenant_id) VALUES ($1, $2, $3, $4)`, [uid, `${uid}@e2e.local`, role, TENANT]),
      ).rejects.toMatchObject({ code: '23514' });
      const r = await pool.query(`SELECT count(*)::int AS n FROM users WHERE firebase_uid = $1`, [uid]);
      expect(r.rows[0].n).toBe(0);
    });

    it('tipo declarado no INSERT vence o papel (é o que o código novo grava)', async () => {
      const uid = `${PREFIXO}declarado`;
      await pool.query(`INSERT INTO users (firebase_uid, email, role, account_type, tenant_id) VALUES ($1, $2, 'admin', 'worker', $3)`, [uid, `${uid}@e2e.local`, TENANT]);
      const r = await pool.query(`SELECT account_type FROM users WHERE firebase_uid = $1`, [uid]);
      expect(r.rows[0].account_type).toBe('worker');
    });

    it('lex C3: UPDATE de role (direto e via change_user_role) recalcula o tipo', async () => {
      const uid = `${PREFIXO}update`;
      await pool.query(`INSERT INTO users (firebase_uid, email, role, tenant_id) VALUES ($1, $2, 'admin', $3)`, [uid, `${uid}@e2e.local`, TENANT]);

      await pool.query(`UPDATE users SET role = 'worker' WHERE firebase_uid = $1`, [uid]);
      expect((await pool.query(`SELECT account_type FROM users WHERE firebase_uid = $1`, [uid])).rows[0].account_type).toBe('worker');

      await pool.query(`SELECT change_user_role($1, 'recruiter', '{}'::jsonb)`, [uid]);
      expect((await pool.query(`SELECT account_type FROM users WHERE firebase_uid = $1`, [uid])).rows[0].account_type).toBe('staff');

      // UPDATE que NÃO toca em role não mexe no tipo
      await pool.query(`UPDATE users SET display_name = 'x' WHERE firebase_uid = $1`, [uid]);
      expect((await pool.query(`SELECT account_type FROM users WHERE firebase_uid = $1`, [uid])).rows[0].account_type).toBe('staff');
    });
  });

  describe('a fronteira na API (USE_MOCK_AUTH: o token leva o que o claim levaria)', () => {
    const chamar = (payload: Record<string, unknown>) =>
      api.get('/api/admin/users', { headers: { Authorization: tokenMock({ uid: `${PREFIXO}http`, email: 'h@e2e.local', ...payload }) } });

    it('só role=admin (conta anterior ao backfill): a ponte deixa entrar', async () => {
      expect((await chamar({ role: 'admin' })).status).toBe(200);
    });

    it('só account_type=staff (sem papel): entra', async () => {
      expect((await chamar({ account_type: 'staff' })).status).toBe(200);
    });

    it('account_type=worker com role=admin: o tipo declarado vence → 403 Staff access required', async () => {
      const res = await chamar({ role: 'admin', account_type: 'worker' });
      expect(res.status).toBe(403);
      expect(res.data).toMatchObject({ error: 'Staff access required' });
    });

    it('lex C5: sem tipo e sem papel → 403 (a ponte nunca concede por ausência)', async () => {
      expect((await chamar({})).status).toBe(403);
    });

    it('papel legado sem tipo (manager) → 403', async () => {
      expect((await chamar({ role: 'manager' })).status).toBe(403);
    });
  });
});
