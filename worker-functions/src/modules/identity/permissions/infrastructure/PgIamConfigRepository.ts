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
import { STAFF_ACCOUNT_TYPE } from './PgEffectiveAuthzRepository';
import type { IamConfigSnapshot, IamImportOp, IamImportPlan } from '../application/iamConfig/types';
import { normalizeSnapshot } from '../application/iamConfig/snapshot';

interface GroupRow { id: string; name: string; description: string | null; is_system: boolean }

/**
 * "Staff elegível" para a configuração IAM. Vale para `staffUidsByEmail`
 * (a checagem de ADD — `add_member` continua exigindo staff) — NÃO para
 * `exportSnapshot`, nem para a remoção.
 *
 * (M1) Até aqui esta constante também filtrava `members` em `exportSnapshot`,
 * e o motivo do M3 original — as duas pontas precisavam concordar em quem é
 * "staff elegível", senão `remove_member` explodia `applyOp` no meio da
 * transação — deixou de valer: o export agora lista TODO vínculo vivo, sem
 * filtro de role, porque um admin REBAIXADO (role saiu das 3 de staff) continua
 * com a célula no banco (`iam.add_member` não valida role, e
 * `effective_permissions`/`effective_countries` filtram por `status`, nunca
 * por role) — filtrar por role no export escondia esse vínculo do
 * `iam-config.json`, o artefato revisável "quem tem o quê". A remoção usa
 * `uidsByEmailAny` (sem filtro de role), uma lookup PRÓPRIA, distinta desta.
 *
 * (D294) Staff é `users.account_type = 'staff'` — vocabulário do banco, o mesmo
 * de `PgEffectiveAuthzRepository`. A fronteira do módulo (`moduleBoundary.test`,
 * D115 §7) proíbe importar de `identity/domain`; a string é estável por CHECK.
 */

export class PgIamConfigRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * O estado do alvo (ou da origem) na forma do snapshot — só grupos vivos,
   * vínculos vivos, overrides.
   *
   * (M1) `members` NÃO filtra por role — TODO vínculo vivo aparece, mesmo o de
   * um usuário cujo role saiu das 3 de staff. `iam.add_member` não valida
   * role, e `effective_permissions`/`effective_countries` filtram por
   * `status`, nunca por role: um admin rebaixado mantém a célula concedida no
   * banco, e o export é o artefato revisável "quem tem o quê" — filtrar por
   * role aqui esconderia esse vínculo vivo de quem revisa o `iam-config.json`.
   */
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

  /**
   * Nomes de grupo ARQUIVADOS do alvo (M4). `exportSnapshot` só devolve grupos
   * vivos (contrato do snapshot); sem isto o planner não sabe que um nome
   * "ausente" pode estar arquivado, e tenta `create_group` — a UNIQUE
   * `(tenant_id, name)` da 206 não é parcial (cobre arquivado também) e o
   * INSERT estoura 23505 no meio da transação, depois de um dry-run limpo.
   */
  async archivedGroupNames(tenantId: string): Promise<Set<string>> {
    const r = await this.pool.query<{ name: string }>(
      `SELECT name FROM iam.permission_groups WHERE tenant_id = $1 AND archived_at IS NOT NULL`,
      [tenantId],
    );
    return new Set(r.rows.map((x) => x.name));
  }

  /**
   * O tenant que o BANCO-ALVO efetivamente serve (M5) — não o `tenantId` que
   * vem dentro do JSON `desired`. É o que torna a guarda `tenant_mismatch` do
   * planner real: se o script chamar `exportSnapshot(desired.tenantId)`, o
   * `current.tenantId` vira sempre igual ao `desired.tenantId` por construção,
   * e um JSON com tenant errado nunca é pego.
   *
   * (M4) O que esta função PEGA: lê `iam.current_tenant_id()` num `pg.Pool` cru
   * — sem `app.tenant_id` setado por sessão (não há GUC de tenant fora de uma
   * transação com `SET LOCAL`/RLS), essa função devolve a constante única da
   * mig 206. Isso detecta divergência entre o JSON `desired` (editado à mão,
   * por ex.) e ESSA constante — é o caso real de `tenant_mismatch` hoje.
   *
   * O que ela NÃO PEGA: se o operador apontar `DATABASE_URL`/`--tenant` para o
   * banco-alvo ERRADO (produção em vez de stage, por ex.), esta função não tem
   * como perceber — ela lê o único tenant que aquele banco conhece, e a guarda
   * `tenant_mismatch` fica inerte contra esse erro específico (é por isso que
   * `--tenant` no script é conferência humana, não substituto de auditoria de
   * `DATABASE_URL`).
   */
  async resolveTenantId(): Promise<string> {
    const r = await this.pool.query<{ id: string }>(`SELECT iam.current_tenant_id() AS id`);
    return r.rows[0].id;
  }

  /**
   * e-mail (minúsculo) → uid dos STAFF (`account_type = 'staff'`) com conta no alvo. Usada só
   * para a checagem de ADD (`add_member` continua exigindo staff) — NÃO para
   * `exportSnapshot` nem para REMOVE (M1: ver `uidsByEmailAny`).
   */
  async staffUidsByEmail(): Promise<Map<string, string>> {
    const r = await this.pool.query<{ email: string; firebase_uid: string }>(
      `SELECT lower(email) AS email, firebase_uid FROM users
        WHERE account_type = $1 AND email IS NOT NULL`,
      [STAFF_ACCOUNT_TYPE],
    );
    return new Map(r.rows.map((x) => [x.email, x.firebase_uid]));
  }

  /**
   * (M1) e-mail (minúsculo) → uid de QUALQUER conta no alvo, sem filtro de
   * role — a lookup PRÓPRIA para REMOVE, distinta de `staffUidsByEmail` (ADD).
   * `exportSnapshot` deixou de filtrar `members` por role, então um vínculo
   * vivo de alguém rebaixado (role fora das 3 de staff) aparece em
   * `current.members`; usar `staffUidsByEmail` aqui faria `remove_member`
   * explodir `applyOp` no meio da transação com "e-mail sem conta no alvo",
   * quando a conta existe — só não é mais staff.
   */
  async uidsByEmailAny(): Promise<Map<string, string>> {
    const r = await this.pool.query<{ email: string; firebase_uid: string }>(
      `SELECT lower(email) AS email, firebase_uid FROM users WHERE email IS NOT NULL`,
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
      // M1: duas lookups distintas — `staffUids` para `add_member` (continua
      // exigindo staff), `anyUids` para `remove_member` (sem filtro de role,
      // senão remover um vínculo rebaixado explode aqui com "e-mail sem conta").
      const staffUids = await this.staffUidsByEmail();
      const anyUids = await this.uidsByEmailAny();
      let n = 0;
      for (const op of plan.ops) {
        await this.applyOp(client, op, { tenantId: args.tenantId, reason: args.reason, groupIds, staffUids, anyUids });
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
    ctx: { tenantId: string; reason: string; groupIds: Map<string, string>; staffUids: Map<string, string>; anyUids: Map<string, string> },
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
      case 'add_member': {
        // Continua exigindo staff — a lookup É `staffUids` de propósito (M1).
        const uid = ctx.staffUids.get(op.email);
        if (!uid) throw new Error(`add_member: e-mail sem conta staff no alvo no grupo ${op.group} (o plano deveria tê-lo listado como pendência; e-mail fora da mensagem — nunca em log)`);
        await client.query(`SELECT iam.add_member($1, $2)`, [this.groupId(ctx.groupIds, op.group), uid]);
        return;
      }
      case 'remove_member': {
        // (M1) SEM filtro de role — resolve o vínculo mesmo se o role saiu das
        // 3 de staff (admin rebaixado, por ex.), que é exatamente o caso que a
        // remoção existe para fechar.
        const uid = ctx.anyUids.get(op.email);
        if (!uid) throw new Error(`remove_member: e-mail sem conta no alvo no grupo ${op.group} (o plano deveria tê-lo listado como pendência; e-mail fora da mensagem — nunca em log)`);
        await client.query(`SELECT iam.remove_member($1, $2)`, [this.groupId(ctx.groupIds, op.group), uid]);
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
