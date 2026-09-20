/**
 * loginRoles — usuário de LOGIN temporário, membro de uma role de grupo do ABAC (`app_runtime`/
 * `app_system`), para o e2e falar com o banco como a API fala em stg/prd (269/273).
 *
 * Extraído em 08/09/2026 (gate da 419): o mesmo bloco vivia em `country-context-app`,
 * `dual-pool-routing` e `abac-admin-routes` — os três continuam com a cópia própria (LISTA);
 * quem nasce depois usa este helper. Roles de teste não têm dado: `DROP ROLE` no fim basta.
 */
import type { Pool } from 'pg';

/** A MESMA base, com outro login — o que muda é só quem conecta. */
export function urlFor(databaseUrl: string, user: string, password: string): string {
  const url = new URL(databaseUrl);
  url.username = user;
  url.password = password;
  return url.toString();
}

/** Cria (se não existe) o login e o liga ao grupo — idempotente, como o runbook manda. */
export async function ensureLoginRole(admin: Pool, user: string, password: string, group?: 'app_runtime' | 'app_system'): Promise<void> {
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${user}') THEN CREATE ROLE ${user} LOGIN PASSWORD '${password}'; END IF;
  END $$;`);
  if (group) await admin.query(`GRANT ${group} TO ${user}`);
}

export async function dropLoginRoles(admin: Pool, users: readonly string[]): Promise<void> {
  await admin.query(`DROP ROLE IF EXISTS ${users.join(', ')}`);
}
