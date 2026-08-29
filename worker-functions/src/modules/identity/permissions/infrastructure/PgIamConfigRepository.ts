/**
 * src/modules/identity/permissions/infrastructure/PgIamConfigRepository.ts
 *
 * O I/O do export/import da configuração IAM (D208). Leitura por SELECT (as roles
 * do app já têm SELECT em `iam.*`, 274); ESCRITA SÓ pelas funções SECURITY DEFINER
 * da 279 — nunca INSERT/UPDATE direto —, numa transação única com o ator
 * declarado por GUC (`app.user_uid`), que é como `_require_manager` e o
 * anti-lockout decidem. Se qualquer passo falhar (23514 do último gestor,
 * 42501 do ator sem célula), a transação inteira volta: "nada aplicado".
 */

import type { Pool, PoolClient } from 'pg';
import { cellKey } from '../domain/PermissionCell';
import type { IamConfigSnapshot, IamImportOp, IamImportPlan } from '../application/iamConfig/types';
import { normalizeSnapshot } from '../application/iamConfig/snapshot';

interface GroupRow { id: string; name: string; description: string | null; is_system: boolean }

export class PgIamConfigRepository {
  constructor(private readonly pool: Pool) {}

  /** O estado do alvo (ou da origem) na forma do snapshot — só grupos vivos, vínculos vivos, overrides. */
  async exportSnapshot(tenantId: string): Promise<IamConfigSnapshot> {
    const groups = await this.pool.query<GroupRow>(
      `SELECT id, name, description, is_system FROM iam.permission_groups
        WHERE tenant_id = $1 AND archived_at IS NULL ORDER BY name`,
      [tenantId],
    );
    const cells = await this.pool.query<{ group_id: string; key: string }>(
      `SELECT gp.group_id, p.resource || ':' || p.action AS key
         FROM iam.group_permissions gp JOIN iam.permissions p ON p.id = gp.permission_id
        WHERE gp.group_id = ANY($1) AND p.deprecated_at IS NULL`,
      [groups.rows.map((g) => g.id)],
    );
    const countries = await this.pool.query<{ group_id: string; country: string }>(
      `SELECT group_id, country FROM iam.group_country_scopes WHERE group_id = ANY($1) AND revoked_at IS NULL`,
      [groups.rows.map((g) => g.id)],
    );
    const members = await this.pool.query<{ group_id: string; email: string }>(
      `SELECT ug.group_id, u.email FROM iam.user_groups ug JOIN users u ON u.firebase_uid = ug.user_id
        WHERE ug.group_id = ANY($1) AND ug.removed_at IS NULL AND u.email IS NOT NULL`,
      [groups.rows.map((g) => g.id)],
    );
    const features = await this.pool.query<{ country: string; feature_key: string; enabled: boolean; config: unknown }>(
      `SELECT country, feature_key, enabled, config FROM iam.country_features WHERE source = 'override'`,
    );
    const pick = <T extends { group_id: string }>(rows: T[], id: string) => rows.filter((r) => r.group_id === id);
    return normalizeSnapshot({
      version: 1,
      tenantId,
      groups: groups.rows.map((g) => ({
        name: g.name,
        description: g.description,
        isSystem: g.is_system,
        cells: pick(cells.rows, g.id).map((r) => r.key),
        countries: pick(countries.rows, g.id).map((r) => r.country),
        members: pick(members.rows, g.id).map((r) => r.email),
      })),
      countryFeatures: features.rows.map((f) => ({ country: f.country, featureKey: f.feature_key, enabled: f.enabled, config: f.config })),
    });
  }

  /** Células vivas do catálogo do alvo. */
  async liveCells(): Promise<Set<string>> {
    const r = await this.pool.query<{ resource: string; action: string }>(
      `SELECT resource, action FROM iam.permissions WHERE deprecated_at IS NULL`,
    );
    return new Set(r.rows.map((x) => cellKey(x.resource, x.action)));
  }

  /** e-mail (minúsculo) → uid dos staff com conta no alvo. */
  async staffUidsByEmail(): Promise<Map<string, string>> {
    const r = await this.pool.query<{ email: string; firebase_uid: string }>(
      `SELECT lower(email) AS email, firebase_uid FROM users
        WHERE role IN ('admin', 'recruiter', 'community_manager') AND email IS NOT NULL`,
    );
    return new Map(r.rows.map((x) => [x.email, x.firebase_uid]));
  }

  /** uid do ator pelo e-mail, ou null. */
  async uidByEmail(email: string): Promise<string | null> {
    const r = await this.pool.query<{ firebase_uid: string }>(`SELECT firebase_uid FROM users WHERE lower(email) = lower($1)`, [email]);
    return r.rows[0]?.firebase_uid ?? null;
  }

  /**
   * Aplica o plano numa transação só, como o ator. Devolve quantas operações
   * rodaram. Plano com erro é recusado ANTES de abrir a transação.
   */
  async applyPlan(plan: IamImportPlan, args: { tenantId: string; actorUid: string; reason: string }): Promise<number> {
    if (plan.errors.length > 0) throw new Error(`plano com ${plan.errors.length} erro(s) — nada aplicado`);
    if (plan.ops.length === 0) return 0;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.user_uid', $1, true)`, [args.actorUid]);
      const groupIds = await this.groupIdsByName(client, args.tenantId);
      const uids = await this.staffUidsByEmail();
      let n = 0;
      for (const op of plan.ops) {
        await this.applyOp(client, op, { tenantId: args.tenantId, reason: args.reason, groupIds, uids });
        n += 1;
      }
      await client.query('COMMIT');
      return n;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  private async groupIdsByName(client: PoolClient, tenantId: string): Promise<Map<string, string>> {
    const r = await client.query<{ id: string; name: string }>(
      `SELECT id, name FROM iam.permission_groups WHERE tenant_id = $1 AND archived_at IS NULL`,
      [tenantId],
    );
    return new Map(r.rows.map((g) => [g.name, g.id]));
  }

  private groupId(groupIds: Map<string, string>, name: string): string {
    const id = groupIds.get(name);
    if (!id) throw new Error(`grupo '${name}' não existe no alvo (o plano deveria tê-lo criado antes)`);
    return id;
  }

  private async applyOp(
    client: PoolClient,
    op: IamImportOp,
    ctx: { tenantId: string; reason: string; groupIds: Map<string, string>; uids: Map<string, string> },
  ): Promise<void> {
    switch (op.kind) {
      case 'create_group': {
        const r = await client.query<{ id: string }>(`SELECT iam.create_group($1, $2, $3) AS id`, [ctx.tenantId, op.group, op.description]);
        ctx.groupIds.set(op.group, r.rows[0].id);
        return;
      }
      case 'update_group':
        await client.query(`SELECT iam.update_group($1, NULL, $2)`, [this.groupId(ctx.groupIds, op.group), op.description]);
        return;
      case 'archive_group':
        await client.query(`SELECT iam.archive_group($1)`, [this.groupId(ctx.groupIds, op.group)]);
        return;
      case 'set_permissions': {
        const ids = await client.query<{ id: string }>(
          `SELECT id FROM iam.permissions WHERE resource || ':' || action = ANY($1) AND deprecated_at IS NULL`,
          [op.cells],
        );
        if (ids.rowCount !== op.cells.length) throw new Error(`células desconhecidas no alvo para '${op.group}'`);
        await client.query(`SELECT iam.set_group_permissions($1, $2::uuid[], $3)`, [
          this.groupId(ctx.groupIds, op.group),
          ids.rows.map((x) => x.id),
          ctx.reason,
        ]);
        return;
      }
      case 'grant_country':
        await client.query(`SELECT iam.grant_country($1, $2, $3)`, [this.groupId(ctx.groupIds, op.group), op.country, ctx.reason]);
        return;
      case 'revoke_country':
        await client.query(`SELECT iam.revoke_country($1, $2)`, [this.groupId(ctx.groupIds, op.group), op.country]);
        return;
      case 'add_member':
      case 'remove_member': {
        const uid = ctx.uids.get(op.email);
        if (!uid) throw new Error(`e-mail sem conta no alvo: ${op.email} (o plano deveria tê-lo listado como pendência)`);
        const fn = op.kind === 'add_member' ? 'iam.add_member' : 'iam.remove_member';
        await client.query(`SELECT ${fn}($1, $2)`, [this.groupId(ctx.groupIds, op.group), uid]);
        return;
      }
      case 'set_country_feature':
        await client.query(`SELECT iam.set_country_feature($1, $2, $3, $4::jsonb, $5)`, [
          op.country,
          op.featureKey,
          op.enabled,
          op.config === null ? null : JSON.stringify(op.config),
          ctx.reason,
        ]);
        return;
    }
  }
}
