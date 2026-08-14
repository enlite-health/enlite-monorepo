/**
 * src/shared/database/assertDbRoleMembership.ts
 *
 * Trava de BOOT da RLS de país (ABAC Fase 1, BLOCKER-1).
 *
 * As policies das migrations 271/272 concedem acesso por MEMBERSHIP de role:
 * `app_runtime` (staff, confinado ao país) e `app_system` (cron/webhook/rota
 * pública). O login da aplicação recebe essa membership por `GRANT` — e um
 * `GRANT` é exatamente o tipo de coisa que some sem barulho: migration nova que
 * esquece a linha, restore de banco, usuário recriado à mão em incidente.
 *
 * Sem membership, a aplicação sobe com health 200 e devolve ZERO linha em toda
 * tabela protegida — o painel apaga em produção e o log não diz por quê. Este
 * assert transforma isso em falha de deploy: o processo recusa subir, a revisão
 * do Cloud Run não recebe tráfego e a anterior continua servindo.
 *
 * Custo com a flag desligada: ZERO (nem query nem conexão).
 */

import type { Pool } from 'pg';
import { isCountryRlsEnabled } from './requestDbSession';

/** Role exigida em cada identidade. */
const RUNTIME_ROLE = 'app_runtime';
const SYSTEM_ROLE = 'app_system';

interface MembershipRow {
  member: boolean | null;
  who: string;
}

async function assertMembership(pool: Pool, role: string, label: string): Promise<string> {
  let row: MembershipRow | undefined;
  try {
    const result = await pool.query<MembershipRow>(
      `SELECT pg_has_role(current_user, $1, 'MEMBER') AS member, current_user AS who`,
      [role],
    );
    row = result.rows[0];
  } catch (err) {
    // Falha ao VERIFICAR também é falha: subir sem saber é o cenário que este
    // assert existe para impedir (fail-closed).
    throw new Error(
      `[abac] não foi possível verificar a membership de ${role} no pool de ${label}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (!row?.member) {
    throw new Error(
      `[abac] o usuário de banco "${row?.who ?? 'desconhecido'}" NÃO é membro de ${role} ` +
        `(pool de ${label}) e COUNTRY_RLS_ENABLED=true — toda tabela protegida devolveria zero ` +
        'linha. Rode o GRANT que falta (migrations 268-272) antes de subir.',
    );
  }
  return row.who;
}

/**
 * Verifica as memberships exigidas pela RLS e LANÇA se faltar alguma.
 *
 * @param runtimePool pool com a identidade de runtime (`getRawPool()`)
 * @param systemPool  pool de sistema (`getSystemPool()`); igual ao de runtime na
 *                    configuração de pool único — aí só a checagem de runtime roda,
 *                    porque não existe segunda identidade para verificar.
 */
export async function assertDbRoleMembership(runtimePool: Pool, systemPool: Pool): Promise<void> {
  if (!isCountryRlsEnabled()) return;

  await assertMembership(runtimePool, RUNTIME_ROLE, 'runtime');
  if (systemPool !== runtimePool) {
    await assertMembership(systemPool, SYSTEM_ROLE, 'sistema');
  }
}
