/**
 * src/modules/identity/permissions/infrastructure/PgPermissionGroupRepository.ts
 *
 * Leitura direta das tabelas `iam.*` (as roles do app têm SELECT) e escrita
 * EXCLUSIVAMENTE pelas funções `SECURITY DEFINER` da mig 279 (lex C4). Não há
 * um único INSERT/UPDATE/DELETE neste arquivo — de propósito: a role do app não
 * tem esse privilégio, e o dia em que alguém tentar, o banco recusa.
 *
 * Todo método recebe `tenantId` e o usa no WHERE das LEITURAS. Grupo de outro
 * tenant volta `null`/vazio — indistinguível de inexistente (spec
 * permission-groups). Nas ESCRITAS o tenant é derivado do próprio grupo dentro
 * da função (ela lê `permission_groups` e chama `_require_manager(tenant)`), o
 * que evita a classe de bug "passei o tenant errado e escrevi no grupo do
 * vizinho".
 */

import type { Pool } from 'pg';
import type { CountryCode } from '@shared/domain/countryCodes';
import { isCountryCode } from '@shared/domain/countryCodes';
import type {
  CreateGroupInput,
  GroupMemberView,
  PermissionGroupRepository,
} from '../application/ports';
import type { PermissionGroupDetail } from '../domain/PermissionGroup';
import type { GroupMembership } from '../domain/GroupMembership';
import { PermissionError } from '../domain/PermissionError';
import { readRows, withStaffWrite } from './dbAccess';

interface GroupRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  is_system: boolean;
  archived_at: Date | null;
  created_by: string | null;
  created_at: Date;
  cells: string[];
  countries: string[];
  member_count: number;
}

const GROUP_COLUMNS = `
  g.id, g.tenant_id, g.name, g.description, g.is_system, g.archived_at, g.created_by, g.created_at,
  COALESCE(ARRAY(
    SELECT p.resource || ':' || p.action
      FROM iam.group_permissions gp
      JOIN iam.permissions p ON p.id = gp.permission_id AND p.deprecated_at IS NULL
     WHERE gp.group_id = g.id
     ORDER BY 1), '{}') AS cells,
  COALESCE(ARRAY(
    SELECT DISTINCT gcs.country
      FROM iam.group_country_scopes gcs
     WHERE gcs.group_id = g.id AND gcs.revoked_at IS NULL
     ORDER BY 1), '{}') AS countries,
  (SELECT count(*)::int FROM iam.user_groups ug
    WHERE ug.group_id = g.id AND ug.removed_at IS NULL) AS member_count`;

function toDetail(row: GroupRow): PermissionGroupDetail {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    description: row.description,
    isSystem: row.is_system,
    archivedAt: row.archived_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    cells: row.cells ?? [],
    countries: (row.countries ?? []).filter(isCountryCode),
    memberCount: row.member_count ?? 0,
  };
}

export class PgPermissionGroupRepository implements PermissionGroupRepository {
  constructor(private readonly pool: Pool) {}

  async list(tenantId: string, options?: { includeArchived?: boolean }): Promise<PermissionGroupDetail[]> {
    const result = await readRows(() =>
      this.pool.query<GroupRow>(
        `SELECT ${GROUP_COLUMNS}
           FROM iam.permission_groups g
          WHERE g.tenant_id = $1
            AND ($2::boolean OR g.archived_at IS NULL)
          ORDER BY g.is_system DESC, g.name`,
        [tenantId, options?.includeArchived === true],
      ),
    );
    return result.rows.map(toDetail);
  }

  async findById(tenantId: string, groupId: string): Promise<PermissionGroupDetail | null> {
    const result = await readRows(() =>
      this.pool.query<GroupRow>(
        `SELECT ${GROUP_COLUMNS}
           FROM iam.permission_groups g
          WHERE g.tenant_id = $1 AND g.id = $2`,
        [tenantId, groupId],
      ),
    );
    const row = result.rows[0];
    return row ? toDetail(row) : null;
  }

  async listMembers(tenantId: string, groupId: string): Promise<GroupMemberView[]> {
    const result = await readRows(() =>
      this.pool.query<{
        user_id: string;
        email: string | null;
        role: string | null;
        status: string | null;
        assigned_by: string | null;
        assigned_at: Date;
      }>(
        `SELECT ug.user_id, u.email, u.role, u.status, ug.assigned_by, ug.assigned_at
           FROM iam.user_groups ug
           JOIN iam.permission_groups g ON g.id = ug.group_id AND g.tenant_id = $1
           LEFT JOIN users u ON u.firebase_uid = ug.user_id
          WHERE ug.group_id = $2 AND ug.removed_at IS NULL
          ORDER BY u.email NULLS LAST`,
        [tenantId, groupId],
      ),
    );
    return result.rows.map((row) => ({
      userId: row.user_id,
      email: row.email,
      role: row.role,
      status: row.status as GroupMemberView['status'],
      assignedBy: row.assigned_by,
      assignedAt: row.assigned_at,
    }));
  }

  async liveMemberUids(tenantId: string, groupId: string): Promise<string[]> {
    const result = await readRows(() =>
      this.pool.query<{ user_id: string }>(
        `SELECT ug.user_id
           FROM iam.user_groups ug
           JOIN iam.permission_groups g ON g.id = ug.group_id AND g.tenant_id = $1
          WHERE ug.group_id = $2 AND ug.removed_at IS NULL`,
        [tenantId, groupId],
      ),
    );
    return result.rows.map((row) => row.user_id);
  }

  async membershipHistory(tenantId: string, groupId: string, userId: string): Promise<GroupMembership[]> {
    const result = await readRows(() =>
      this.pool.query<{
        id: string;
        user_id: string;
        group_id: string;
        tenant_id: string;
        assigned_by: string | null;
        assigned_at: Date;
        removed_by: string | null;
        removed_at: Date | null;
      }>(
        `SELECT ug.id, ug.user_id, ug.group_id, ug.tenant_id, ug.assigned_by, ug.assigned_at,
                ug.removed_by, ug.removed_at
           FROM iam.user_groups ug
           JOIN iam.permission_groups g ON g.id = ug.group_id AND g.tenant_id = $1
          WHERE ug.group_id = $2 AND ug.user_id = $3
          ORDER BY ug.assigned_at`,
        [tenantId, groupId, userId],
      ),
    );
    return result.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      groupId: row.group_id,
      tenantId: row.tenant_id,
      assignedBy: row.assigned_by,
      assignedAt: row.assigned_at,
      removedBy: row.removed_by,
      removedAt: row.removed_at,
    }));
  }

  // ── Escrita: só pelas funções da 279 ────────────────────────────────────────

  async create(input: CreateGroupInput): Promise<string> {
    return withStaffWrite(this.pool, async (client) => {
      const result = await client.query<{ id: string }>(
        `SELECT iam.create_group($1, $2, $3) AS id`,
        [input.tenantId, input.name, input.description ?? null],
      );
      const id = result.rows[0]?.id;
      if (!id) throw new PermissionError('invalid_input', 'Grupo não foi criado');
      return id;
    });
  }

  async update(groupId: string, patch: { name?: string; description?: string | null }): Promise<void> {
    await withStaffWrite(this.pool, (client) =>
      client.query(`SELECT iam.update_group($1, $2, $3)`, [
        groupId,
        patch.name ?? null,
        patch.description ?? null,
      ]),
    );
  }

  async archive(groupId: string): Promise<void> {
    await withStaffWrite(this.pool, (client) => client.query(`SELECT iam.archive_group($1)`, [groupId]));
  }

  async setPermissions(groupId: string, permissionIds: string[], reason: string): Promise<void> {
    await withStaffWrite(this.pool, (client) =>
      client.query(`SELECT iam.set_group_permissions($1, $2::uuid[], $3)`, [groupId, permissionIds, reason]),
    );
  }

  async grantCountry(groupId: string, country: CountryCode, reason: string | null): Promise<string> {
    return withStaffWrite(this.pool, async (client) => {
      const result = await client.query<{ id: string }>(`SELECT iam.grant_country($1, $2, $3) AS id`, [
        groupId,
        country,
        reason,
      ]);
      return result.rows[0].id;
    });
  }

  async revokeCountry(groupId: string, country: CountryCode): Promise<number> {
    return withStaffWrite(this.pool, async (client) => {
      const result = await client.query<{ n: number }>(`SELECT iam.revoke_country($1, $2) AS n`, [
        groupId,
        country,
      ]);
      return result.rows[0]?.n ?? 0;
    });
  }

  async addMember(groupId: string, userId: string): Promise<string> {
    return withStaffWrite(this.pool, async (client) => {
      const result = await client.query<{ id: string }>(`SELECT iam.add_member($1, $2) AS id`, [
        groupId,
        userId,
      ]);
      return result.rows[0].id;
    });
  }

  async removeMember(groupId: string, userId: string): Promise<number> {
    return withStaffWrite(this.pool, async (client) => {
      const result = await client.query<{ n: number }>(`SELECT iam.remove_member($1, $2) AS n`, [
        groupId,
        userId,
      ]);
      return result.rows[0]?.n ?? 0;
    });
  }
}
