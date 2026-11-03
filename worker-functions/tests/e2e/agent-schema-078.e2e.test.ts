/**
 * agent-schema-078.e2e.test.ts — spec 078, fase M2 (migration 556): o agente como pessoa no ABAC, provado no BANCO real.
 *
 * Seção 1 (M2.1.1): `users.account_type` aceita `agent` e continua recusando o resto. Banco: DATABASE_URL (dono, só para
 * semear e medir catálogo). Nada passa pela API. As seções seguintes (2: triggers; 3: auditoria; 4: seed) entram nas
 * tasks M2.1.3, M2.1.5 e M2.1.7, neste MESMO arquivo.
 */
import { Pool } from 'pg';
import { isStaffAccount } from '../../src/modules/identity/domain/AccountType';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const TENANT = '00000000-0000-0000-0000-000000000001';
const PREFIXO = 'e2e-agent078-';

let pool: Pool;

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
});
afterAll(async () => {
  await pool.query(`DELETE FROM users WHERE firebase_uid LIKE $1`, [`${PREFIXO}%`]);
  await pool.end();
});

describe('556 §1 — users.account_type aceita `agent`', () => {
  const inserir = (uid: string, role: string, tipo: string) =>
    pool.query(
      `INSERT INTO users (firebase_uid, email, role, account_type, tenant_id) VALUES ($1, $2, $3, $4, $5)`,
      [uid, `${uid}@e2e.local`, role, tipo, TENANT],
    );

  it('account_type=agent grava (role=support: a ponte não classifica, o tipo vai declarado)', async () => {
    await inserir(`${PREFIXO}ok-agent`, 'support', 'agent');
    const r = await pool.query(`SELECT account_type FROM users WHERE firebase_uid = $1`, [`${PREFIXO}ok-agent`]);
    expect(r.rows).toEqual([{ account_type: 'agent' }]);
  });

  it('controle: staff e worker seguem gravando', async () => {
    await inserir(`${PREFIXO}ok-staff`, 'recruiter', 'staff');
    await inserir(`${PREFIXO}ok-worker`, 'worker', 'worker');
    const r = await pool.query(`SELECT account_type FROM users WHERE firebase_uid LIKE $1 ORDER BY 1`, [`${PREFIXO}ok-%`]);
    expect(r.rows.map((x) => x.account_type).sort()).toEqual(['agent', 'staff', 'worker']);
  });

  it.each([['bot'], ['patient'], ['']])('account_type=%j → check_violation (23514, nunca vira tipo novo por engano)', async (tipo) => {
    await expect(inserir(`${PREFIXO}no-${tipo || 'vazio'}`, 'support', tipo)).rejects.toMatchObject({ code: '23514' });
    const r = await pool.query(`SELECT count(*)::int AS n FROM users WHERE firebase_uid = $1`, [`${PREFIXO}no-${tipo || 'vazio'}`]);
    expect(r.rows[0].n).toBe(0);
  });

  it('o CHECK do catálogo lista exatamente staff|worker|agent', async () => {
    const r = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'public.users'::regclass AND conname = 'users_account_type_check'`,
    );
    expect(r.rows).toHaveLength(1);
    for (const t of ['staff', 'worker', 'agent']) expect(r.rows[0].def).toContain(`'${t}'`);
  });

  it('isStaffAccount({accountType:"agent"}) continua false (fail-closed: agente não é staff)', () => {
    expect(isStaffAccount({ accountType: 'agent' })).toBe(false);
    expect(isStaffAccount({ accountType: 'staff' })).toBe(true); // controle positivo
  });
});
