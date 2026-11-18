/**
 * countryGrant — concede pais (AR+BR) por GRUPO ao ator staff dos e2e, de forma CENTRAL.
 *
 * Por que existe (hotfix 18/11/2026): `resolveCountryScope` agora recorta lista/ficha/agregados pelo pais efetivo do ator
 * (`iam.effective_countries`, so por grupo). Ator staff sem grupo com pais recebe 403 COUNTRY_SCOPE_REQUIRED; os e2e que
 * so querem exercitar a rota (e nao o escopo) herdam este padrao via `staffAuth` e `getMockToken` — sem editar 1 por 1.
 *
 * Os testes de ESCOPO (country-scope-*.e2e) NAO herdam: usam `getMockToken(..., { countryGrant: false })` e montam grupos
 * explicitos so-AR / sem pais / AR+BR.
 *
 * Mecanica (idempotente, segura com jest paralelo):
 *  - registra o uid em `e2e_country_grants` e cria um usuario PLACEHOLDER (ON CONFLICT DO NOTHING) para o grant valer
 *    mesmo em teste que so usa token e nunca grava `users`;
 *  - trigger BEFORE INSERT em `users`: se o teste gravar o PROPRIO usuario depois, o placeholder sai (um INSERT simples
 *    do teste nao pode colidir com ele); trigger AFTER INSERT recoloca o membro no grupo — o grant sobrevive;
 *  - so existe no banco de e2e (criado aqui, nunca em migration).
 */
import { Pool } from 'pg';

const TENANT = '00000000-0000-0000-0000-000000000001';
const GROUP = 'ee270000-0f00-0009-0001-000000000001';
const SCOPE_AR = 'ee270000-0f00-0009-0002-000000000001';
const SCOPE_BR = 'ee270000-0f00-0009-0002-000000000002';
const PLACEHOLDER = 'e2e-country-grant-placeholder';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

let pool: Pool | null = null;
let ready: Promise<void> | null = null;

function db(): Pool {
  return (pool ??= new Pool({ connectionString: DATABASE_URL, max: 2 }));
}

async function install(p: Pool): Promise<void> {
  const c = await p.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT pg_advisory_xact_lock(727001)`);
    await c.query(`CREATE TABLE IF NOT EXISTS e2e_country_grants (uid VARCHAR PRIMARY KEY)`);
    await c.query(`
      CREATE OR REPLACE FUNCTION e2e_country_grant_before_user() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        DELETE FROM users WHERE firebase_uid = NEW.firebase_uid AND display_name = '${PLACEHOLDER}';
        RETURN NEW;
      END $f$`);
    await c.query(`
      CREATE OR REPLACE FUNCTION e2e_country_grant_after_user() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        IF EXISTS (SELECT 1 FROM e2e_country_grants g WHERE g.uid = NEW.firebase_uid) THEN
          INSERT INTO user_groups (user_id, group_id, tenant_id) VALUES (NEW.firebase_uid, '${GROUP}', '${TENANT}')
          ON CONFLICT DO NOTHING;
        END IF;
        RETURN NEW;
      END $f$`);
    await c.query(`CREATE OR REPLACE TRIGGER e2e_country_grant_before BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION e2e_country_grant_before_user()`);
    await c.query(`CREATE OR REPLACE TRIGGER e2e_country_grant_after AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION e2e_country_grant_after_user()`);
    await c.query(`INSERT INTO permission_groups (id, tenant_id, name) VALUES ($1, $2, 'e2e default AR+BR') ON CONFLICT DO NOTHING`, [GROUP, TENANT]);
    await c.query(
      `INSERT INTO group_country_scopes (id, group_id, country, granted_by, reason) VALUES ($1, $3, 'AR', 'e2e-default', 'padrao dos e2e'), ($2, $3, 'BR', 'e2e-default', 'padrao dos e2e') ON CONFLICT DO NOTHING`,
      [SCOPE_AR, SCOPE_BR, GROUP],
    );
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

/** Concede AR+BR por grupo ao `uid` (staff). Idempotente. */
export async function grantDefaultCountries(uid: string): Promise<void> {
  const p = db();
  await (ready ??= install(p));
  await p.query(`INSERT INTO e2e_country_grants (uid) VALUES ($1) ON CONFLICT DO NOTHING`, [uid]);
  // Placeholder so se o usuario ainda nao existe; o AFTER INSERT ja o coloca no grupo.
  await p.query(
    `INSERT INTO users (firebase_uid, email, display_name, role, is_active, tenant_id)
     VALUES ($1, $2, '${PLACEHOLDER}', 'recruiter', true, $3) ON CONFLICT (firebase_uid) DO NOTHING`,
    [uid, `${uid}@e2e-placeholder.local`, TENANT],
  );
  // Usuario que ja existia (gravado pelo teste antes do token): entra no grupo direto.
  await p.query(
    `INSERT INTO user_groups (user_id, group_id, tenant_id) SELECT firebase_uid, $2, $3 FROM users WHERE firebase_uid = $1 ON CONFLICT DO NOTHING`,
    [uid, GROUP, TENANT],
  );
}
