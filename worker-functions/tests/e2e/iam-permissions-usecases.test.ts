import { Pool } from 'pg';
import { loggingAls } from '@shared/logging';
import {
  createPermissionsModule,
  PERMISSION_CHANGED_EVENT,
  COUNTRY_FEATURE_CHANGED_EVENT,
  ENLITE_TENANT_ID,
  type PermissionsModule,
} from '@modules/identity/permissions';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

/**
 * E2E de banco real dos USE CASES do módulo de permissões (change
 * painel-grupos-permissao, grupo 2).
 *
 * O ponto deste arquivo é o que unit com mock NÃO consegue provar:
 *   · a escrita passa mesmo pelas funções `SECURITY DEFINER` (mig 279/281) e o
 *     ator sai do GUC — nunca de parâmetro;
 *   · as invariantes concorrentes do banco (anti-lockout com lock, unicidade de
 *     nome, célula fora do catálogo) chegam à aplicação como o erro certo;
 *   · o efeito de cada operação em `iam.effective_permissions/countries`, que é
 *     o que a RLS e o painel realmente leem;
 *   · o evento de invalidação chega no outbox.
 *
 * O módulo roda sob a role `app_runtime` (`options: '-c role=app_runtime'`) — a
 * mesma do serviço depois da virada (D112). Rodar como superusuário esconderia
 * exatamente a classe de erro que a 279 existe para provocar.
 *
 * O anti-lockout é exercitado num TENANT PRÓPRIO: no tenant Enlite o harness tem
 * outros gestores (e teria que suspendê-los), então "o último gestor" seria uma
 * condição frágil, dependente da ordem dos arquivos de teste.
 */
describe('IAM — use cases do painel de grupos (banco real, role app_runtime)', () => {
  let admin: Pool;
  let appPool: Pool;
  let systemPool: Pool;
  let permissions: PermissionsModule;

  const TENANT2 = 'ee290000-0000-0000-0000-0000000000t2'.replace('t2', '02');
  const U = {
    gestor: 'iam-uc-gestor',
    ana: 'iam-uc-ana',
    bob: 'iam-uc-bob',
    gestor2: 'iam-uc-gestor2',
  };
  const GROUP_NAME = 'IAM UC Recrutamento';
  const FEATURE_KEY = 'screen:iam-uc-teste';
  const TEST_CELL = { resource: 'iam_uc_teste', action: 'execute' };

  /** Roda `fn` como o staff informado — é o que carimba `app.user_uid`. */
  function asStaff<T>(uid: string, fn: () => Promise<T>): Promise<T> {
    return loggingAls.run(
      { traceId: `e2e-${uid}`, dbSession: { released: false, context: { kind: 'staff', uid } } },
      fn,
    );
  }

  const effective = (uid: string, tenant = ENLITE_TENANT_ID) =>
    admin
      .query(`SELECT iam.effective_permissions($1, $2) AS p, iam.effective_countries($1, $2) AS c`, [uid, tenant])
      .then((r) => r.rows[0] as { p: string[]; c: string[] });

  async function cleanup(): Promise<void> {
    await admin.query(`DELETE FROM domain_events WHERE event IN ($1, $2) AND payload::text LIKE '%iam-uc-%'`, [
      PERMISSION_CHANGED_EVENT,
      COUNTRY_FEATURE_CHANGED_EVENT,
    ]);
    await admin.query(`DELETE FROM domain_events WHERE event = $1 AND payload->>'featureKey' = $2`, [
      COUNTRY_FEATURE_CHANGED_EVENT,
      FEATURE_KEY,
    ]);
    await admin.query(`DELETE FROM iam.country_feature_changes WHERE feature_key = $1`, [FEATURE_KEY]);
    await admin.query(`DELETE FROM iam.country_features WHERE feature_key = $1`, [FEATURE_KEY]);
    await admin.query(`DELETE FROM iam.permission_audit_log WHERE user_id = ANY($1)`, [Object.values(U)]);
    await admin.query(
      `DELETE FROM iam.permission_group_changes WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name LIKE 'IAM UC%')`,
    );
    await admin.query(
      `DELETE FROM iam.group_country_scopes WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name LIKE 'IAM UC%')`,
    );
    await admin.query(
      `DELETE FROM iam.group_permissions WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name LIKE 'IAM UC%')`,
    );
    await admin.query(`DELETE FROM iam.user_groups WHERE user_id = ANY($1)`, [Object.values(U)]);
    await admin.query(`DELETE FROM iam.permission_groups WHERE name LIKE 'IAM UC%'`);
    await admin.query(`DELETE FROM users WHERE firebase_uid = ANY($1)`, [Object.values(U)]);
    await admin.query(`DELETE FROM iam.permissions WHERE resource = $1`, [TEST_CELL.resource]);
    await admin.query(`DELETE FROM iam.tenants WHERE id = $1`, [TENANT2]);
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });
    appPool = new Pool({ connectionString: DATABASE_URL, options: '-c role=app_runtime' });
    // Pool de SISTEMA — os syncs de boot (catálogo, manifest) só têm EXECUTE por
    // `app_system` (ACL das migs 279/281). Com `app_runtime` aqui, os testes de
    // sync falham com `permission denied` — foi o que aconteceu na 1ª execução,
    // e é a prova de que o gate por ACL está de pé.
    systemPool = new Pool({ connectionString: DATABASE_URL, options: '-c role=app_system' });
    await cleanup();

    await admin.query(`INSERT INTO iam.tenants (id, name, region, status) VALUES ($1, 'IAM UC Tenant 2', 'SA', 'ACTIVE')`, [TENANT2]);
    await admin.query(
      `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES
         ($1, 'iam-uc-gestor@e2e.local', 'admin',     'ACTIVE', true, $5),
         ($2, 'iam-uc-ana@e2e.local',    'recruiter', 'ACTIVE', true, $5),
         ($3, 'iam-uc-bob@e2e.local',    'recruiter', 'ACTIVE', true, $5),
         ($4, 'iam-uc-gestor2@e2e.local','admin',     'ACTIVE', true, $5)`,
      [U.gestor, U.ana, U.bob, U.gestor2, ENLITE_TENANT_ID],
    );

    // gestor do tenant Enlite: entra no Acesso Master (tem permission_management:write)
    const master = await admin.query(`SELECT id FROM iam.permission_groups WHERE name = 'Acesso Master' AND tenant_id = $1`, [ENLITE_TENANT_ID]);
    await admin.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [
      U.gestor,
      master.rows[0].id,
      ENLITE_TENANT_ID,
    ]);

    // tenant 2: um grupo com permission_management:write e UM único gestor
    const g2 = await admin.query(
      `INSERT INTO iam.permission_groups (tenant_id, name, description, is_system) VALUES ($1, 'IAM UC Gestores T2', 'e2e', false) RETURNING id`,
      [TENANT2],
    );
    await admin.query(
      `INSERT INTO iam.group_permissions (group_id, permission_id)
         SELECT $1, id FROM iam.permissions WHERE resource = 'permission_management'`,
      [g2.rows[0].id],
    );
    await admin.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [
      U.gestor2,
      g2.rows[0].id,
      TENANT2,
    ]);
    tenant2GroupId = g2.rows[0].id;

    permissions = createPermissionsModule({
      pool: appPool,
      systemPool,
      staffRoles: ['admin', 'recruiter', 'community_manager'],
      ttlMs: 0, // sem cache: cada asserção lê o estado real
    });
  });

  let tenant2GroupId: string;
  let groupId: string;

  afterAll(async () => {
    await cleanup();
    await admin.end();
    await appPool.end();
    await systemPool.end();
  });

  // ── Ciclo completo do painel ───────────────────────────────────────────────
  describe('criar → marcar células → conceder país → colocar gente', () => {
    it('cria o grupo com o ator vindo do GUC (não de parâmetro)', async () => {
      const result = await asStaff(U.gestor, () =>
        permissions.groups.create.execute({ tenantId: ENLITE_TENANT_ID, name: GROUP_NAME, description: 'e2e' }),
      );
      groupId = result.groupId;
      const row = await admin.query(`SELECT created_by, is_system FROM iam.permission_groups WHERE id = $1`, [groupId]);
      expect(row.rows[0]).toEqual({ created_by: U.gestor, is_system: false });
    });

    it('nome duplicado no mesmo tenant é rejeitado', async () => {
      await expect(
        asStaff(U.gestor, () =>
          permissions.groups.create.execute({ tenantId: ENLITE_TENANT_ID, name: GROUP_NAME }),
        ),
      ).rejects.toMatchObject({ code: 'duplicate_name' });
    });

    it('staff SEM permission_management:write não cria nada (fail-closed no banco)', async () => {
      await expect(
        asStaff(U.ana, () => permissions.groups.create.execute({ tenantId: ENLITE_TENANT_ID, name: 'IAM UC da Ana' })),
      ).rejects.toMatchObject({ code: 'forbidden' });
    });

    it('marca células: vira group_permissions + trilha do diff', async () => {
      await asStaff(U.gestor, () =>
        permissions.groups.setPermissions.execute({
          tenantId: ENLITE_TENANT_ID,
          groupId,
          cellKeys: ['vacancy:read', 'vacancy:write'],
          reason: 'setup do e2e',
        }),
      );
      const changes = await admin.query(
        `SELECT op, changed_by, reason FROM iam.permission_group_changes WHERE group_id = $1 ORDER BY changed_at`,
        [groupId],
      );
      expect(changes.rows).toHaveLength(2);
      expect(changes.rows[0]).toMatchObject({ op: 'add', changed_by: U.gestor, reason: 'setup do e2e' });
    });

    it('célula fora do catálogo é recusada dizendo QUAL — e nada é gravado', async () => {
      await expect(
        asStaff(U.gestor, () =>
          permissions.groups.setPermissions.execute({
            tenantId: ENLITE_TENANT_ID,
            groupId,
            cellKeys: ['vacancy:read', 'inventada:read'],
          }),
        ),
      ).rejects.toThrow(/inventada:read/);
      const cells = await admin.query(`SELECT count(*)::int n FROM iam.group_permissions WHERE group_id = $1`, [groupId]);
      expect(cells.rows[0].n).toBe(2);
    });

    it('concede país com motivo (idempotente) e o país aparece em effective_countries', async () => {
      await asStaff(U.gestor, () =>
        permissions.groups.addMember.execute({ tenantId: ENLITE_TENANT_ID, groupId, userId: U.ana }),
      );
      const first = await asStaff(U.gestor, () =>
        permissions.groups.grantCountry.execute({ tenantId: ENLITE_TENANT_ID, groupId, country: 'BR', reason: 'expansão comercial' }),
      );
      const again = await asStaff(U.gestor, () =>
        permissions.groups.grantCountry.execute({ tenantId: ENLITE_TENANT_ID, groupId, country: 'BR', reason: 'de novo' }),
      );
      expect(again.scopeId).toBe(first.scopeId);

      const ana = await effective(U.ana);
      expect(ana.c).toContain('BR');
      expect(ana.p).toEqual(expect.arrayContaining(['vacancy:read', 'vacancy:write']));

      const scope = await admin.query(
        `SELECT granted_by, reason FROM iam.group_country_scopes WHERE group_id = $1 AND revoked_at IS NULL`,
        [groupId],
      );
      expect(scope.rows[0]).toEqual({ granted_by: U.gestor, reason: 'expansão comercial' });
    });

    it('🔒 motivo OPCIONAL: sem ele o país é concedido — mas o texto, quando vem, segue validado', async () => {
      // mig 412. A trilha do ato é `granted_by` + `created_at` + `revoked_at`;
      // o texto livre colhia "ok" e ".".
      const { scopeId } = await asStaff(U.gestor, () =>
        permissions.groups.grantCountry.execute({ tenantId: ENLITE_TENANT_ID, groupId, country: 'AR', reason: '   ' }),
      );
      expect(scopeId).toBeTruthy();
      const linha = await admin.query<{ reason: string | null; granted_by: string }>(
        `SELECT reason, granted_by FROM iam.group_country_scopes WHERE id = $1`, [scopeId]);
      expect(linha.rows[0].reason).toBeNull();
      expect(linha.rows[0].granted_by).toBe(U.gestor);

      // o guarda que NÃO caiu: dado de pessoa no motivo continua recusado
      await expect(
        asStaff(U.gestor, () =>
          permissions.groups.grantCountry.execute({
            tenantId: ENLITE_TENANT_ID, groupId, country: 'BR', reason: 'pedido de ana@enlite.health',
          }),
        ),
      ).rejects.toMatchObject({ code: 'invalid_input' });
    });

    it('revogar o país tira o acesso na consulta seguinte', async () => {
      const { revoked } = await asStaff(U.gestor, () =>
        permissions.groups.revokeCountry.execute({ tenantId: ENLITE_TENANT_ID, groupId, country: 'BR' }),
      );
      expect(revoked).toBe(1);
      expect((await effective(U.ana)).c).not.toContain('BR');

      // idempotente: revogar de novo não é erro, só não muda nada
      const outra = await asStaff(U.gestor, () =>
        permissions.groups.revokeCountry.execute({ tenantId: ENLITE_TENANT_ID, groupId, country: 'BR' }),
      );
      expect(outra.revoked).toBe(0);
    });

    it('publica permission.changed com os uids afetados', async () => {
      const events = await admin.query(
        `SELECT payload FROM domain_events WHERE event = $1 AND payload::text LIKE '%iam-uc-ana%' ORDER BY created_at`,
        [PERMISSION_CHANGED_EVENT],
      );
      expect(events.rowCount).toBeGreaterThan(0);
      expect(events.rows[events.rowCount! - 1].payload.uids).toContain(U.ana);
    });
  });

  // ── Membership com histórico ───────────────────────────────────────────────
  describe('membership preserva histórico', () => {
    it('remover é soft: removed_at/by gravados e o vínculo antigo continua consultável', async () => {
      await asStaff(U.gestor, () =>
        permissions.groups.removeMember.execute({ tenantId: ENLITE_TENANT_ID, groupId, userId: U.ana }),
      );
      const rows = await admin.query(
        `SELECT assigned_by, removed_by, removed_at FROM iam.user_groups WHERE group_id = $1 AND user_id = $2`,
        [groupId, U.ana],
      );
      expect(rows.rows[0].removed_by).toBe(U.gestor);
      expect(rows.rows[0].removed_at).not.toBeNull();
      expect((await effective(U.ana)).p).not.toContain('vacancy:write');

      const historico = await permissions.repositories.groups.membershipHistory(ENLITE_TENANT_ID, groupId, U.ana);
      expect(historico).toHaveLength(1);
      expect(historico[0].assignedBy).toBe(U.gestor);
    });

    it('re-adicionar cria vínculo novo, sem apagar o anterior', async () => {
      await asStaff(U.gestor, () =>
        permissions.groups.addMember.execute({ tenantId: ENLITE_TENANT_ID, groupId, userId: U.ana }),
      );
      const historico = await permissions.repositories.groups.membershipHistory(ENLITE_TENANT_ID, groupId, U.ana);
      expect(historico).toHaveLength(2);
      expect(historico.filter((m) => m.removedAt === null)).toHaveLength(1);
    });
  });

  // ── Grupos de sistema e arquivamento ───────────────────────────────────────
  describe('grupo de sistema e arquivamento', () => {
    it('grupo de sistema não renomeia nem arquiva', async () => {
      const master = await admin.query(`SELECT id FROM iam.permission_groups WHERE name = 'Acesso Master' AND tenant_id = $1`, [ENLITE_TENANT_ID]);
      const id = master.rows[0].id as string;
      await expect(
        asStaff(U.gestor, () => permissions.groups.update.execute({ tenantId: ENLITE_TENANT_ID, groupId: id, name: 'Outro nome' })),
      ).rejects.toMatchObject({ code: 'system_group' });
      await expect(
        asStaff(U.gestor, () => permissions.groups.archive.execute({ tenantId: ENLITE_TENANT_ID, groupId: id })),
      ).rejects.toMatchObject({ code: 'system_group' });
    });

    it('arquivar com membros: eles perdem o que o grupo dava, e o histórico fica', async () => {
      const { affectedMembers } = await asStaff(U.gestor, () =>
        permissions.groups.archive.execute({ tenantId: ENLITE_TENANT_ID, groupId }),
      );
      expect(affectedMembers).toBe(1);
      expect((await effective(U.ana)).p).not.toContain('vacancy:read');
      const row = await admin.query(`SELECT archived_by FROM iam.permission_groups WHERE id = $1`, [groupId]);
      expect(row.rows[0].archived_by).toBe(U.gestor);
    });
  });

  // ── Tenant ─────────────────────────────────────────────────────────────────
  describe('escopo por tenant', () => {
    it('grupo de OUTRO tenant é indistinguível de inexistente (404, não 403)', async () => {
      await expect(
        asStaff(U.gestor, () =>
          permissions.groups.update.execute({ tenantId: ENLITE_TENANT_ID, groupId: tenant2GroupId, name: 'IAM UC roubado' }),
        ),
      ).rejects.toMatchObject({ code: 'not_found' });
      expect(await permissions.repositories.groups.findById(ENLITE_TENANT_ID, tenant2GroupId)).toBeNull();
    });
  });

  // ── Anti-lockout ───────────────────────────────────────────────────────────
  describe('anti-lockout do último gestor', () => {
    it('remover o ÚNICO gestor do tenant é rejeitado e nada muda', async () => {
      const antes = await admin.query(
        `SELECT count(*)::int n FROM iam.user_groups WHERE group_id = $1 AND removed_at IS NULL`,
        [tenant2GroupId],
      );
      await expect(
        asStaff(U.gestor2, () =>
          permissions.groups.removeMember.execute({ tenantId: TENANT2, groupId: tenant2GroupId, userId: U.gestor2 }),
        ),
      ).rejects.toMatchObject({ code: 'last_manager' });
      const depois = await admin.query(
        `SELECT count(*)::int n FROM iam.user_groups WHERE group_id = $1 AND removed_at IS NULL`,
        [tenant2GroupId],
      );
      expect(depois.rows[0].n).toBe(antes.rows[0].n);
      expect((await effective(U.gestor2, TENANT2)).p).toContain('permission_management:write');
    });

    it('tirar a célula de gestão do único grupo que a dá também é rejeitado', async () => {
      await expect(
        asStaff(U.gestor2, () =>
          permissions.groups.setPermissions.execute({ tenantId: TENANT2, groupId: tenant2GroupId, cellKeys: ['vacancy:read'] }),
        ),
      ).rejects.toMatchObject({ code: 'last_manager' });
      expect((await effective(U.gestor2, TENANT2)).p).toContain('permission_management:write');
    });
  });

  // ── Disponibilidade por país ───────────────────────────────────────────────
  describe('disponibilidade por país', () => {
    it('sync grava o default; override do painel ganha e SOBREVIVE ao sync seguinte', async () => {
      await permissions.repositories.features.syncDefault('AR', FEATURE_KEY, true, null);
      await asStaff(U.gestor, () =>
        permissions.features.set.execute({
          country: 'AR',
          featureKey: FEATURE_KEY,
          enabled: false,
          config: null,
          reason: 'não vale para a Argentina por enquanto',
        }),
      );
      await permissions.repositories.features.syncDefault('AR', FEATURE_KEY, true, null);

      const row = await admin.query(
        `SELECT enabled, source, updated_by, reason FROM iam.country_features WHERE country = 'AR' AND feature_key = $1`,
        [FEATURE_KEY],
      );
      expect(row.rows[0]).toEqual({
        enabled: false,
        source: 'override',
        updated_by: U.gestor,
        reason: 'não vale para a Argentina por enquanto',
      });

      const changes = await admin.query(`SELECT changed_by, new_source FROM iam.country_feature_changes WHERE feature_key = $1`, [FEATURE_KEY]);
      expect(changes.rows).toEqual([{ changed_by: U.gestor, new_source: 'override' }]);
    });

    it('o serviço lê a disponibilidade do banco por cima do manifest', async () => {
      expect(await permissions.client.isFeatureAvailable('AR', FEATURE_KEY)).toBe(false);
      // chave que ninguém declarou: fail-closed
      expect(await permissions.client.isFeatureAvailable('AR', 'screen:nunca-declarada')).toBe(false);
    });

    it('publica country_feature.changed', async () => {
      const events = await admin.query(
        `SELECT payload FROM domain_events WHERE event = $1 AND payload->>'featureKey' = $2`,
        [COUNTRY_FEATURE_CHANGED_EVENT, FEATURE_KEY],
      );
      expect(events.rowCount).toBe(1);
      expect(events.rows[0].payload).toEqual({ country: 'AR', featureKey: FEATURE_KEY });
    });
  });

  // ── Catálogo derivado ──────────────────────────────────────────────────────
  describe('catálogo derivado do código', () => {
    it('sync insere a célula nova e descontinua a que sumiu — sem apagar linha', async () => {
      const vivas = await admin.query<{ resource: string; action: string }>(
        `SELECT resource, action FROM iam.permissions WHERE deprecated_at IS NULL`,
      );
      const declaradas = vivas.rows.map((row) => ({ resource: row.resource, action: row.action }));

      // 1) com o catálogo atual + a célula de teste: nada é descontinuado
      const comNova = await permissions.repositories.catalog.sync([...declaradas, TEST_CELL], 'worker-functions');
      expect(comNova).toMatchObject({ inserted: 1, deprecated: 0 });
      const nova = await admin.query(`SELECT category, owner_service, deprecated_at FROM iam.permissions WHERE resource = $1`, [TEST_CELL.resource]);
      expect(nova.rows[0]).toMatchObject({ category: 'Não categorizado', owner_service: 'worker-functions', deprecated_at: null });

      // 2) sem ela: some do catálogo vivo, mas a LINHA continua lá (histórico)
      const semNova = await permissions.repositories.catalog.sync(declaradas, 'worker-functions');
      expect(semNova.deprecated).toBe(1);
      const depois = await admin.query(`SELECT deprecated_at FROM iam.permissions WHERE resource = $1`, [TEST_CELL.resource]);
      expect(depois.rows[0].deprecated_at).not.toBeNull();

      // 3) declarada de novo: revive
      const revivida = await permissions.repositories.catalog.sync([...declaradas, TEST_CELL], 'worker-functions');
      expect(revivida.revived).toBe(1);
      await permissions.repositories.catalog.sync(declaradas, 'worker-functions'); // volta ao estado do harness
      const restante = await admin.query(`SELECT count(*)::int n FROM iam.permissions WHERE deprecated_at IS NULL`);
      expect(restante.rows[0].n).toBe(vivas.rowCount);
    });

    it('lista VAZIA é recusada pelo banco — não descontinua o catálogo inteiro', async () => {
      await expect(permissions.repositories.catalog.sync([], 'worker-functions')).rejects.toThrow(/fail-closed|VAZIA/i);
      const vivas = await admin.query(`SELECT count(*)::int n FROM iam.permissions WHERE deprecated_at IS NULL`);
      expect(vivas.rows[0].n).toBeGreaterThan(30);
    });

    it('app_runtime NÃO chama as funções de sync do catálogo (ACL — mig 281)', async () => {
      const client = await appPool.connect();
      try {
        await client.query(`SELECT set_config('app.system_context', 'job:forjado', false)`);
        await expect(
          client.query(`SELECT iam.sync_permission_cell('x', 'y', NULL, 'Operações', 'worker-functions')`),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        client.release();
      }
    });
  });

  // ── Gate da virada ─────────────────────────────────────────────────────────
  describe('gate da virada (staff sem grupo + marcador de rollout)', () => {
    it('conta staff ACTIVE sem nenhum grupo e lê o marcador', async () => {
      const report = await permissions.assertStaffHasGroup.execute(ENLITE_TENANT_ID);
      expect(report.count).toBeGreaterThan(0); // bob nunca entrou em grupo nenhum
      expect(report.migrated).toBe(false); // migração de dados é do grupo 5

      await admin.query(
        `INSERT INTO iam.rollout_state (key, value, note) VALUES ('permission_groups_migrated', 'done', 'e2e')
         ON CONFLICT (key) DO UPDATE SET value = 'done'`,
      );
      expect((await permissions.assertStaffHasGroup.execute(ENLITE_TENANT_ID)).migrated).toBe(true);
      await admin.query(`DELETE FROM iam.rollout_state WHERE key = 'permission_groups_migrated'`);
    });

    it('alertOnBoot nunca lança, mesmo com o engine ligado e staff sem grupo', async () => {
      await expect(permissions.assertStaffHasGroup.alertOnBoot(ENLITE_TENANT_ID, true)).resolves.toBeUndefined();
    });
  });

  // ── Contrato agregado ──────────────────────────────────────────────────────
  describe('GET /v1/me/authz (contrato agregado)', () => {
    it('devolve permissões, países, status, grupos e features numa resposta só', async () => {
      const authz = await permissions.authz.execute({ uid: U.gestor, tenantId: ENLITE_TENANT_ID });
      expect(authz.status).toBe('ACTIVE');
      expect(authz.permissions).toContain('permission_management:write');
      expect(authz.groups.map((g) => g.name)).toContain('Acesso Master');
      expect(authz.features.AR).toBeDefined();
    });

    it('staff sem grupo volta vazio — é quem cai na tela de boas-vindas', async () => {
      const authz = await permissions.authz.execute({ uid: U.bob, tenantId: ENLITE_TENANT_ID });
      expect(authz.permissions).toEqual([]);
      expect(authz.countries).toEqual([]);
      expect(authz.groups).toEqual([]);
      expect(authz.status).toBe('ACTIVE');
    });
  });

  // ── Auditoria ──────────────────────────────────────────────────────────────
  describe('auditoria', () => {
    it('leitura é gated na célula e registra o próprio ato (lex C7)', async () => {
      await expect(asStaff(U.ana, () => permissions.audit.execute({ limit: 5 }))).rejects.toMatchObject({
        code: 'forbidden',
      });
      const rows = await asStaff(U.gestor, () => permissions.audit.execute({ limit: 5 }));
      expect(Array.isArray(rows)).toBe(true);
      const registro = await admin.query(
        `SELECT decision FROM iam.permission_audit_log WHERE user_id = $1 AND resource = 'permission_audit'`,
        [U.gestor],
      );
      expect(registro.rows[0]).toEqual({ decision: 'ALLOW' });
    });
  });
});
