/**
 * area-membership-runtime-grants.e2e.test.ts — os DOIS LADOS da escrita (spec acesso-do-cliente, F1, T122; migration 581).
 *
 * Conecta como MEMBRO de app_runtime (login sem superuser, mesmo padrão do e2e de `iam.person`): o CI roda como
 * superuser e não acusa grant a mais ou a menos. Fixtures sintéticas; a tabela é append-only (não apaga).
 *
 * Lado 1: INSERT, UPDATE e DELETE direto em iam.area_membership → permission denied (LISTA 19).
 * Lado 2: iam.grant_area_membership grava 1 linha; iam.effective_area_memberships (e SELECT) a lêem;
 *         iam.revoke_area_membership a revoga.
 */
import { randomBytes } from 'crypto';
import { Pool } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const RUN = randomBytes(4).toString('hex');
const uid = (n: string) => `e2e-area-rt-${RUN}-${n}`;
const ATOR = uid('ator');
const RT_USER = 'wf_area_runtime';
const RT_PASSWORD = 'wf_area_runtime_pw';

let admin: Pool;
let runtime: Pool;

function urlAs(user: string, password: string): string {
  const u = new URL(DATABASE_URL);
  u.username = user;
  u.password = password;
  return u.toString();
}

async function expectDenied(sql: string, params: unknown[]): Promise<void> {
  let err: Error | undefined;
  try {
    await runtime.query(sql, params);
  } catch (e) {
    err = e as Error;
  }
  expect(err).toBeDefined();
  expect(err!.message).toMatch(/permission denied for table area_membership/);
}

/** A pessoa nasce pela função (a runtime não insere em iam.person). */
async function pessoa(n: string): Promise<string> {
  const r = await runtime.query(`SELECT iam.ensure_person('firebase', $1) AS p`, [uid(n)]);
  return r.rows[0].p;
}

beforeAll(async () => {
  admin = new Pool({ connectionString: DATABASE_URL });
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${RT_USER}') THEN
      CREATE ROLE ${RT_USER} LOGIN PASSWORD '${RT_PASSWORD}';
    END IF; END $$`);
  await admin.query(`GRANT app_runtime TO ${RT_USER}`);
  runtime = new Pool({ connectionString: urlAs(RT_USER, RT_PASSWORD) });
});

afterAll(async () => {
  await runtime.end();
  await admin.end();
});

describe('o login do teste é de runtime de verdade', () => {
  it('é membro de app_runtime e NÃO é superuser', async () => {
    const r = await runtime.query(
      `SELECT pg_has_role(current_user, 'app_runtime', 'MEMBER') AS membro,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS super`);
    expect(r.rows[0]).toEqual({ membro: true, super: false });
  });
});

describe('lado 1: escrita direta → permission denied (LISTA 19)', () => {
  let p: string;
  beforeAll(async () => {
    p = await pessoa('negacao');
    await runtime.query(`SELECT iam.grant_area_membership($1, 'learn', 'learner', $2)`, [p, ATOR]);
  });

  it('INSERT direto', async () => {
    await expectDenied(
      `INSERT INTO iam.area_membership (person_id, area, role, granted_by) VALUES ($1, 'learn', 'teacher', $2)`,
      [p, ATOR]);
  });

  it('UPDATE direto', async () => {
    await expectDenied(`UPDATE iam.area_membership SET reason = 'x' WHERE person_id = $1`, [p]);
  });

  it('DELETE direto', async () => {
    await expectDenied(`DELETE FROM iam.area_membership WHERE person_id = $1`, [p]);
  });

  it('privilégios na ACL: runtime e system têm SELECT e nenhuma escrita', async () => {
    const r = await admin.query(
      `SELECT r.rolname,
              has_table_privilege(r.rolname, 'iam.area_membership', 'SELECT') AS sel,
              has_table_privilege(r.rolname, 'iam.area_membership', 'INSERT') AS ins,
              has_table_privilege(r.rolname, 'iam.area_membership', 'UPDATE') AS upd,
              has_table_privilege(r.rolname, 'iam.area_membership', 'DELETE') AS del
         FROM pg_roles r WHERE r.rolname IN ('app_runtime', 'app_system') ORDER BY r.rolname`);
    expect(r.rows).toEqual([
      { rolname: 'app_runtime', sel: true, ins: false, upd: false, del: false },
      { rolname: 'app_system', sel: true, ins: false, upd: false, del: false },
    ]);
  });
});

describe('lado 2: escrita e leitura por função (como app_runtime)', () => {
  it('grant_area_membership grava 1 linha e effective_area_memberships a devolve', async () => {
    const p = await pessoa('funcao');
    const g = await runtime.query(`SELECT iam.grant_area_membership($1, 'learn', 'teacher', $2) AS id`, [p, ATOR]);
    expect(g.rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
    const linhas = await runtime.query(
      `SELECT area, role, granted_by, revoked_at FROM iam.area_membership WHERE person_id = $1`, [p]);
    expect(linhas.rows).toEqual([{ area: 'learn', role: 'teacher', granted_by: ATOR, revoked_at: null }]);
    const e = await runtime.query(`SELECT * FROM iam.effective_area_memberships($1)`, [p]);
    expect(e.rows).toEqual([{ area: 'learn', role: 'teacher' }]);
  });

  it('conceder de novo é idempotente (mesmo id, 1 linha)', async () => {
    const p = await pessoa('idem');
    const a = await runtime.query(`SELECT iam.grant_area_membership($1, 'care', 'family', $2) AS id`, [p, ATOR]);
    const b = await runtime.query(`SELECT iam.grant_area_membership($1, 'care', 'family', $2) AS id`, [p, ATOR]);
    expect(b.rows[0].id).toBe(a.rows[0].id);
    const n = await runtime.query(`SELECT count(*)::int AS n FROM iam.area_membership WHERE person_id = $1`, [p]);
    expect(n.rows[0].n).toBe(1);
  });

  it('par inválido pela função é recusado pelo CHECK; sem ator é recusado', async () => {
    const p = await pessoa('invalido');
    await expect(runtime.query(`SELECT iam.grant_area_membership($1, 'care', 'worker', $2)`, [p, ATOR]))
      .rejects.toThrow(/area_membership_area_role/);
    await expect(runtime.query(`SELECT iam.grant_area_membership($1, 'learn', 'learner', '')`, [p]))
      .rejects.toThrow(/exige o ator/);
  });

  it('revoke_area_membership revoga (com motivo) e effective deixa de devolver; sem motivo é recusado', async () => {
    const p = await pessoa('revoga');
    await runtime.query(`SELECT iam.grant_area_membership($1, 'learn', 'manager', $2)`, [p, ATOR]);
    await expect(runtime.query(`SELECT iam.revoke_area_membership($1, 'learn', 'manager', $2, '')`, [p, ATOR]))
      .rejects.toThrow(/exige o motivo/);
    const r = await runtime.query(`SELECT iam.revoke_area_membership($1, 'learn', 'manager', $2, 'fim do contrato') AS n`, [p, ATOR]);
    expect(r.rows[0].n).toBe(1);
    const e = await runtime.query(`SELECT * FROM iam.effective_area_memberships($1)`, [p]);
    expect(e.rows).toEqual([]);
  });
});
