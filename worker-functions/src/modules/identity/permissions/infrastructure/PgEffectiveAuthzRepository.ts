/**
 * src/modules/identity/permissions/infrastructure/PgEffectiveAuthzRepository.ts
 *
 * Resolve "o que este staff pode e onde" chamando `iam.effective_permissions` e
 * `iam.effective_countries` (mig 276) — as MESMAS funções que a policy RLS de
 * país consulta (lex C3). Não existe cópia da regra em SQL aqui: se a regra
 * mudar, muda no banco e as duas pontas mudam juntas.
 *
 * Tudo é escopado por tenant, sempre por parâmetro (design 12).
 */

import type { Pool } from 'pg';
import type { CountryCode } from '@shared/domain/countryCodes';
import { isCountryCode } from '@shared/domain/countryCodes';
import type { EffectiveAuthzRepository, ResolvedAuthz, StaffStatus } from '../application/ports';
import { readRows } from './dbAccess';

const STATUSES: readonly string[] = ['ACTIVE', 'PENDING_ONBOARDING', 'SUSPENDED', 'DEACTIVATED'];

function asStatus(value: unknown): StaffStatus | null {
  return typeof value === 'string' && STATUSES.includes(value) ? (value as StaffStatus) : null;
}

function asCountries(values: unknown): CountryCode[] {
  return Array.isArray(values) ? values.filter(isCountryCode) : [];
}

/**
 * Snapshot numa consulta só: status, células, países e grupos vigentes.
 *
 * `LEFT JOIN` + `FILTER` porque staff sem grupo TEM que voltar linha (é
 * exatamente quem cai na tela de boas-vindas) — com `INNER JOIN` ele sumiria e o
 * resolver não saberia distinguir "sem grupo" de "usuário inexistente".
 */
const SNAPSHOT_SQL = `
  SELECT u.status,
         iam.effective_permissions($1, $2) AS permissions,
         iam.effective_countries($1, $2)   AS countries,
         COALESCE(
           json_agg(DISTINCT jsonb_build_object('id', g.id, 'name', g.name))
             FILTER (WHERE g.id IS NOT NULL),
           '[]'
         ) AS groups
    FROM users u
    LEFT JOIN iam.user_groups ug
      ON ug.user_id = u.firebase_uid
     AND ug.removed_at IS NULL
    LEFT JOIN iam.permission_groups g
      ON g.id = ug.group_id
     AND g.archived_at IS NULL
     AND g.tenant_id = $2
   WHERE u.firebase_uid = $1
   GROUP BY u.status`;

/**
 * Staff ACTIVE sem NENHUM grupo vigente — a medida do gate da virada (task 2.7).
 * A lista de papéis de staff vem de fora (o módulo não conhece o enum de
 * `identity`, para seguir extraível — D115 §7).
 */
const WITHOUT_GROUP_SQL = `
  SELECT count(*)::int AS n
    FROM users u
   WHERE u.status = 'ACTIVE'
     AND u.role = ANY($2)
     AND NOT EXISTS (
       SELECT 1
         FROM iam.user_groups ug
         JOIN iam.permission_groups g
           ON g.id = ug.group_id
          AND g.archived_at IS NULL
          AND g.tenant_id = $1
        WHERE ug.user_id = u.firebase_uid
          AND ug.removed_at IS NULL
     )`;

export class PgEffectiveAuthzRepository implements EffectiveAuthzRepository {
  constructor(
    private readonly pool: Pool,
    /** Papéis que contam como staff do painel (injetado — ver comentário acima). */
    private readonly staffRoles: readonly string[],
  ) {}

  async effectivePermissions(uid: string, tenantId: string): Promise<string[]> {
    const result = await readRows(() =>
      this.pool.query<{ permissions: string[] }>(
        `SELECT iam.effective_permissions($1, $2) AS permissions`,
        [uid, tenantId],
      ),
    );
    return result.rows[0]?.permissions ?? [];
  }

  async effectiveCountries(uid: string, tenantId: string): Promise<CountryCode[]> {
    const result = await readRows(() =>
      this.pool.query<{ countries: string[] }>(
        `SELECT iam.effective_countries($1, $2) AS countries`,
        [uid, tenantId],
      ),
    );
    return asCountries(result.rows[0]?.countries);
  }

  async snapshot(uid: string, tenantId: string): Promise<ResolvedAuthz> {
    const result = await readRows(() =>
      this.pool.query<{
        status: string | null;
        permissions: string[] | null;
        countries: string[] | null;
        groups: Array<{ id: string; name: string }> | null;
      }>(SNAPSHOT_SQL, [uid, tenantId]),
    );
    const row = result.rows[0];
    return {
      uid,
      tenantId,
      status: asStatus(row?.status),
      permissions: row?.permissions ?? [],
      countries: asCountries(row?.countries),
      groups: row?.groups ?? [],
    };
  }

  async countActiveStaffWithoutGroup(tenantId: string): Promise<number> {
    const result = await readRows(() =>
      this.pool.query<{ n: number }>(WITHOUT_GROUP_SQL, [tenantId, [...this.staffRoles]]),
    );
    return result.rows[0]?.n ?? 0;
  }
}
