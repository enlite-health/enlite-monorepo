/**
 * 419 — o catálogo CID-11 (schema `terminology`) é LEGÍVEL pelo papel de runtime (banco real).
 *
 * O que se prova (D303, fecho na stage): um usuário de LOGIN membro de `app_runtime` (o que a
 * API é em stg/prd com RLS ligado) consegue `USAGE` no schema, `SELECT` nas três tabelas e
 * chamar `terminology.concept_key` — e o mesmo para `app_system`. Controle POSITIVO da régua
 * (D157): um login SEM membership recebe `permission denied` — sem isso, "não deu erro" não
 * distinguiria "concedido" de "ninguém exige".
 */
import { Pool } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const PASSWORD = 'tgrants_e2e_pw';
const USERS = {
  runtime: ['tgrants_runtime', 'app_runtime'],
  system: ['tgrants_system', 'app_system'],
  nobody: ['tgrants_nobody', null],
} as const;

function urlFor(user: string): string {
  const u = new URL(DATABASE_URL);
  u.username = user;
  u.password = PASSWORD;
  return u.toString();
}

describe('419 — grants de leitura do schema terminology para app_runtime/app_system (banco real)', () => {
  let admin: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });
    for (const [user, group] of Object.values(USERS)) {
      await admin.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${user}') THEN CREATE ROLE ${user} LOGIN PASSWORD '${PASSWORD}'; END IF;
      END $$;`);
      if (group) await admin.query(`GRANT ${group} TO ${user}`);
    }
  });

  afterAll(async () => {
    for (const [user] of Object.values(USERS)) await admin.query(`DROP ROLE IF EXISTS ${user}`);
    await admin.end();
  });

  async function como(user: string, sql: string): Promise<{ ok: true; rows: unknown[] } | { ok: false; code: string }> {
    const pool = new Pool({ connectionString: urlFor(user), max: 1 });
    try {
      const r = await pool.query(sql);
      return { ok: true, rows: r.rows };
    } catch (e) {
      return { ok: false, code: (e as { code?: string }).code ?? 'sem-codigo' };
    } finally {
      await pool.end();
    }
  }

  it('privilégios no catálogo: USAGE no schema e SELECT nas 3 tabelas para os dois grupos', async () => {
    const { rows } = await admin.query<{ role: string; usage: boolean; tabelas: number }>(
      `SELECT r AS role,
              has_schema_privilege(r, 'terminology', 'USAGE') AS usage,
              -- por OID (não por nome): o planner pode avaliar o predicado antes do filtro de schema
              (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'terminology' AND c.relkind = 'r'
                  AND has_table_privilege(r, c.oid, 'SELECT')) AS tabelas
         FROM unnest(ARRAY['app_runtime', 'app_system']) AS r`,
    );
    expect(rows).toEqual([
      { role: 'app_runtime', usage: true, tabelas: 3 },
      { role: 'app_system', usage: true, tabelas: 3 },
    ]);
  });

  it.each([USERS.runtime, USERS.system])('login %s (membro de %s) LÊ releases, entidades, sinônimos e chama concept_key', async (user) => {
    for (const sql of [
      'SELECT count(*) FROM terminology.icd_releases',
      'SELECT count(*) FROM terminology.icd_entities',
      'SELECT count(*) FROM terminology.icd_synonyms',
      `SELECT terminology.concept_key('http://id.who.int/icd/release/11/2026-01/mms/1234') AS k`,
    ]) {
      const r = await como(user, sql);
      expect({ sql, ...r }).toMatchObject({ ok: true });
    }
  });

  it('🔒 controle positivo: login SEM membership → 42501 permission denied no schema (a régua mede)', async () => {
    const r = await como(USERS.nobody[0], 'SELECT count(*) FROM terminology.icd_entities');
    expect(r).toEqual({ ok: false, code: '42501' });
  });

  it('só leitura: app_runtime NÃO escreve no catálogo (nenhum código de produção o faz)', async () => {
    const r = await como(USERS.runtime[0], `INSERT INTO terminology.icd_releases (release, entity_count) VALUES ('tgrants-x', 0)`);
    expect(r).toEqual({ ok: false, code: '42501' });
  });
});
