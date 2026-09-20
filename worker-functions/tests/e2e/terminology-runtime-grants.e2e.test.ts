/**
 * 419 — o catálogo CID-11 (schema `terminology`) é LEGÍVEL pelo papel de runtime (banco real).
 *
 * O que se prova (D303, fecho na stage): um usuário de LOGIN membro de `app_runtime` (o que a
 * API é em stg/prd com RLS ligado) tem `USAGE` no schema, `SELECT` nas três tabelas e chama
 * `terminology.concept_key` — e o mesmo para `app_system`. Controle POSITIVO da régua (D157):
 * um login SEM membership recebe `permission denied` — sem isso, "não deu erro" não distinguiria
 * "concedido" de "ninguém exige". A rota HTTP como runtime está em `abac-admin-routes` (caso
 * "terminology/search").
 */
import { Client, Pool } from 'pg';
import { urlFor, ensureLoginRole, dropLoginRoles } from './helpers/loginRoles';
import { MIGRATION_FILES_TERMINOLOGY } from './helpers/terminologyMigrations';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const PASSWORD = 'tgrants_e2e_pw';
const RUNTIME_USER = 'tgrants_runtime';
const SYSTEM_USER = 'tgrants_system';
const NOBODY_USER = 'tgrants_nobody';

const LEITURAS = [
  ['icd_releases', 'SELECT 1 FROM terminology.icd_releases LIMIT 1'],
  ['icd_entities', 'SELECT 1 FROM terminology.icd_entities LIMIT 1'],
  ['icd_synonyms', 'SELECT 1 FROM terminology.icd_synonyms LIMIT 1'],
  ['concept_key', `SELECT terminology.concept_key('http://id.who.int/icd/release/11/2026-01/mms/1234')`],
] as const;

describe('419 — grants de leitura do schema terminology para app_runtime/app_system (banco real)', () => {
  let admin: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });
    await ensureLoginRole(admin, RUNTIME_USER, PASSWORD, 'app_runtime');
    await ensureLoginRole(admin, SYSTEM_USER, PASSWORD, 'app_system');
    await ensureLoginRole(admin, NOBODY_USER, PASSWORD);
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM terminology.icd_releases WHERE release = 'tgrants-x'`); // só se um INSERT indevido passou
    await dropLoginRoles(admin, [RUNTIME_USER, SYSTEM_USER, NOBODY_USER]);
    await admin.end();
  });

  /** Uma consulta, um login: `ok` ou o SQLSTATE — o teste afirma o código, nunca "deu erro". */
  async function como(user: string, sql: string): Promise<{ ok: boolean; code?: string }> {
    const client = new Client({ connectionString: urlFor(DATABASE_URL, user, PASSWORD) });
    await client.connect();
    try {
      await client.query(sql);
      return { ok: true };
    } catch (e) {
      return { ok: false, code: (e as { code?: string }).code ?? 'sem-codigo' };
    } finally {
      await client.end();
    }
  }

  it('privilégios: USAGE no schema e SELECT nas 3 tabelas (e só nelas) para os dois grupos', async () => {
    const { rows } = await admin.query<{ role: string; usage: boolean; tabelas: number; total: number }>(
      `SELECT r AS role,
              has_schema_privilege(r, 'terminology', 'USAGE') AS usage,
              -- por OID (não por nome): o planner pode avaliar o predicado antes do filtro de schema
              (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'terminology' AND c.relkind = 'r' AND has_table_privilege(r, c.oid, 'SELECT')) AS tabelas,
              (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'terminology' AND c.relkind = 'r') AS total
         FROM unnest(ARRAY['app_runtime', 'app_system']) AS r
        ORDER BY r`,
    );
    expect(rows).toEqual([
      { role: 'app_runtime', usage: true, tabelas: 3, total: 3 },
      { role: 'app_system', usage: true, tabelas: 3, total: 3 },
    ]);
  });

  describe.each([
    [RUNTIME_USER, 'app_runtime'],
    [SYSTEM_USER, 'app_system'],
  ])('login %s (membro de %s)', (user) => {
    it.each(LEITURAS)('lê %s', async (_nome, sql) => {
      expect(await como(user, sql)).toEqual({ ok: true });
    });
  });

  it('🔒 controle positivo: login SEM membership → 42501 permission denied no schema (a régua mede)', async () => {
    expect(await como(NOBODY_USER, LEITURAS[1][1])).toEqual({ ok: false, code: '42501' });
  });

  it('só leitura: app_runtime NÃO escreve no catálogo (nenhum código de produção o faz)', async () => {
    expect(await como(RUNTIME_USER, `INSERT INTO terminology.icd_releases (release, entity_count) VALUES ('tgrants-x', 0)`)).toEqual({ ok: false, code: '42501' });
  });

  it('quem RECRIA o schema (icd11-unavailable-real-catalog) reaplica a 324 e a 419 — a lista derivada as contém, na ordem', () => {
    expect(MIGRATION_FILES_TERMINOLOGY).toEqual([
      '323_terminology_icd11_catalog.sql',
      '324_terminology_revoke_default_privileges.sql',
      '328_terminology_concept_key.sql',
      '419_terminology_grants_app_roles.sql',
    ]);
  });

  it('324 continua valendo: NENHUM default privilege no schema para os grupos (tabela futura nasce ilegível)', async () => {
    const { rows } = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM pg_default_acl d
         JOIN pg_namespace n ON n.oid = d.defaclnamespace
         CROSS JOIN LATERAL aclexplode(d.defaclacl) a
        WHERE n.nspname = 'terminology' AND d.defaclobjtype = 'r'
          AND a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('app_runtime', 'app_system'))`,
    );
    expect(rows[0].n).toBe(0);
  });
});
