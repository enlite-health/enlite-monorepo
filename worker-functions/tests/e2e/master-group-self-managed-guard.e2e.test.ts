import { Pool, PoolClient } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

/**
 * E2E de banco real: migration 456 (spec 021, bloco 2) — "só o Acesso Master
 * altera o Acesso Master".
 *
 * `iam._require_manager()` (279) só olha a célula `permission_management:write`
 * — não de qual grupo ela veio. Hoje DOIS grupos têm essa célula (Acesso
 * Master e Super Admin — ver `436_iam_master_grants_all_active_cells.sql` e o
 * seed de 432); a 456 fecha o caminho por onde um gestor do Super Admin, que
 * NUNCA foi posto no Acesso Master, conseguia alterá-lo.
 *
 * PROVA, nos DOIS sentidos (um lado só aprova o defeito do próprio
 * verificador — D157):
 *   · ator com `permission_management:write` que NÃO é membro vivo do Master
 *     → rejeitado, código 42501, mensagem NOMEADA (não "conta fixa" da 451,
 *     não o texto de `_require_manager`) — e o banco fica INTOCADO;
 *   · ator que É membro vivo do Master → aceito, com o efeito de fato gravado.
 *
 * Cobre as 7 funções trocadas pela 456: update_group, archive_group (só o
 * lado NEGATIVO — arquivar o Master de verdade corromperia o fixture global
 * para qualquer outro teste/sessão que rode contra este mesmo banco),
 * set_group_permissions, grant_country, revoke_country, add_member,
 * remove_member.
 */
describe('migration 456 — guard de pertencimento do Acesso Master (banco real)', () => {
  let pool: Pool;

  const TENANT = '00000000-0000-0000-0000-000000000001';
  const MASTER_ID = 'a0000000-0000-0000-0000-000000000001';

  const U = {
    /** Tem `permission_management:write` via Super Admin — NUNCA foi posto no Master. */
    outsider: 'guard456-outsider',
    /** Membro vivo do Acesso Master. */
    master: 'guard456-master-membro',
    /** Alvo de add_member/remove_member nos testes. */
    alvo: 'guard456-alvo',
  };

  let superAdminId: string;
  let permissionManagementWriteId: string;

  async function cleanup(): Promise<void> {
    await pool.query(`DELETE FROM iam.group_country_scopes WHERE group_id = $1 AND (granted_by = ANY($2) OR country = 'AR')`, [
      MASTER_ID,
      Object.values(U),
    ]);
    await pool.query(`DELETE FROM iam.user_groups WHERE user_id = ANY($1)`, [Object.values(U)]);
    await pool.query(`DELETE FROM users WHERE firebase_uid = ANY($1)`, [Object.values(U)]);
  }

  /** Roda `fn` como `uid`, sob `app_runtime` (a role de runtime real — D112). Commita no sucesso, rollback na exceção. */
  async function asActor<T>(uid: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_runtime');
      await client.query(`SELECT set_config('app.user_uid', $1, true)`, [uid]);
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await cleanup();

    const sa = await pool.query<{ id: string }>(`SELECT id FROM iam.permission_groups WHERE name = 'Super Admin'`);
    superAdminId = sa.rows[0].id;
    const cell = await pool.query<{ id: string }>(
      `SELECT id FROM iam.permissions WHERE resource = 'permission_management' AND action = 'write'`,
    );
    permissionManagementWriteId = cell.rows[0].id;
    // Confere a premissa do cabeçalho da 456 antes de testar em cima dela.
    const donos = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM iam.group_permissions WHERE permission_id = $1`,
      [permissionManagementWriteId],
    );
    expect(donos.rows[0].n).toBeGreaterThanOrEqual(2); // Acesso Master + Super Admin, no mínimo

    await pool.query(
      `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES
         ($1, 'guard456-outsider@e2e.local', 'admin', 'ACTIVE', true, $4),
         ($2, 'guard456-master@e2e.local',   'admin', 'ACTIVE', true, $4),
         ($3, 'guard456-alvo@e2e.local',     'recruiter', 'ACTIVE', true, $4)`,
      [U.outsider, U.master, U.alvo, TENANT],
    );
    // outsider: célula via Super Admin, NUNCA no Master.
    await pool.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [
      U.outsider,
      superAdminId,
      TENANT,
    ]);
    // master: membro vivo do Acesso Master.
    await pool.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [
      U.master,
      MASTER_ID,
      TENANT,
    ]);
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it('premissa: outsider tem permission_management:write (via Super Admin) mas NÃO é membro do Master', async () => {
    const r = await pool.query<{ p: string[] }>(`SELECT iam.effective_permissions($1, $2) AS p`, [U.outsider, TENANT]);
    expect(r.rows[0].p).toContain('permission_management:write');
    const membro = await pool.query(
      `SELECT 1 FROM iam.user_groups WHERE user_id = $1 AND group_id = $2 AND removed_at IS NULL`,
      [U.outsider, MASTER_ID],
    );
    expect(membro.rowCount).toBe(0);
  });

  describe('update_group', () => {
    // ⚠️ `p_name` vai como o NOME ATUAL, nunca NULL: `update_group` compara
    // `p_name IS DISTINCT FROM v_g.name` para o veto de is_system (279) — NULL
    // é sempre distinto de um nome não-nulo, então mandar NULL aqui bateria no
    // veto ANTES do guard da 456 e o teste provaria a coisa errada.
    it('outsider → 42501, mensagem própria, e a descrição do Master fica INTOCADA', async () => {
      const antes = (await pool.query<{ description: string | null }>(`SELECT description FROM iam.permission_groups WHERE id = $1`, [MASTER_ID])).rows[0];
      await expect(
        asActor(U.outsider, (c) => c.query(`SELECT iam.update_group($1, 'Acesso Master', 'sabotagem-outsider')`, [MASTER_ID])),
      ).rejects.toMatchObject({
        code: '42501',
        message: expect.stringContaining('não é membro vivo do Acesso Master'),
      });
      const depois = (await pool.query<{ description: string | null }>(`SELECT description FROM iam.permission_groups WHERE id = $1`, [MASTER_ID])).rows[0];
      expect(depois.description).toBe(antes.description);
    });

    it('mensagem NÃO reusa a marca "conta fixa" (451) nem o texto de _require_manager (279)', async () => {
      await expect(
        asActor(U.outsider, (c) => c.query(`SELECT iam.update_group($1, 'Acesso Master', 'sabotagem-outsider-2')`, [MASTER_ID])),
      ).rejects.toMatchObject({
        message: expect.not.stringContaining('conta fixa'),
      });
      await expect(
        asActor(U.outsider, (c) => c.query(`SELECT iam.update_group($1, 'Acesso Master', 'sabotagem-outsider-3')`, [MASTER_ID])),
      ).rejects.toMatchObject({
        message: expect.not.stringContaining('permission_management:write ausente'),
      });
    });

    it('membro do Master → aceito, o efeito é gravado', async () => {
      const antes = (await pool.query<{ description: string | null }>(`SELECT description FROM iam.permission_groups WHERE id = $1`, [MASTER_ID])).rows[0].description;
      await asActor(U.master, (c) => c.query(`SELECT iam.update_group($1, 'Acesso Master', 'e2e-456-ok')`, [MASTER_ID]));
      const depois = (await pool.query<{ description: string | null }>(`SELECT description FROM iam.permission_groups WHERE id = $1`, [MASTER_ID])).rows[0].description;
      expect(depois).toBe('e2e-456-ok');
      // restaura a descrição original — este teste não pode deixar resíduo no fixture global.
      await asActor(U.master, (c) => c.query(`SELECT iam.update_group($1, 'Acesso Master', $2)`, [MASTER_ID, antes]));
    });
  });

  describe('archive_group — só o lado NEGATIVO (o positivo arquivaria o Master de verdade)', () => {
    it('outsider → 42501, e archived_at continua NULL', async () => {
      await expect(asActor(U.outsider, (c) => c.query(`SELECT iam.archive_group($1)`, [MASTER_ID]))).rejects.toMatchObject({
        code: '42501',
        message: expect.stringContaining('não é membro vivo do Acesso Master'),
      });
      const g = (await pool.query<{ archived_at: Date | null }>(`SELECT archived_at FROM iam.permission_groups WHERE id = $1`, [MASTER_ID])).rows[0];
      expect(g.archived_at).toBeNull();
    });
  });

  describe('set_group_permissions', () => {
    it('outsider → 42501, e o conjunto de células do Master não muda', async () => {
      const antes = (await pool.query<{ permission_id: string }>(`SELECT permission_id FROM iam.group_permissions WHERE group_id = $1`, [MASTER_ID])).rows.map((r) => r.permission_id).sort();
      await expect(
        asActor(U.outsider, (c) => c.query(`SELECT iam.set_group_permissions($1, ARRAY[$2]::uuid[], NULL)`, [MASTER_ID, permissionManagementWriteId])),
      ).rejects.toMatchObject({ code: '42501' });
      const depois = (await pool.query<{ permission_id: string }>(`SELECT permission_id FROM iam.group_permissions WHERE group_id = $1`, [MASTER_ID])).rows.map((r) => r.permission_id).sort();
      expect(depois).toEqual(antes);
    });

    it('membro do Master → aceito (reafirma o conjunto atual, sem perder nada)', async () => {
      // Só as células NÃO descontinuadas: `set_group_permissions` recusa (23503) qualquer id com
      // `deprecated_at` preenchido, e a 453 depreciou 22 `:write` — algumas delas concedidas ao
      // Master pela própria 436 antes da 453 rodar. Reafirmar o conjunto TODO (com deprecadas
      // misturadas) reprovaria por 23503, que não é o que este teste quer provar.
      const antes = (
        await pool.query<{ permission_id: string }>(
          `SELECT gp.permission_id FROM iam.group_permissions gp
             JOIN iam.permissions p ON p.id = gp.permission_id
            WHERE gp.group_id = $1 AND p.deprecated_at IS NULL`,
          [MASTER_ID],
        )
      ).rows.map((r) => r.permission_id).sort();
      await asActor(U.master, (c) => c.query(`SELECT iam.set_group_permissions($1, $2::uuid[], NULL)`, [MASTER_ID, antes]));
      const depois = (await pool.query<{ permission_id: string }>(`SELECT permission_id FROM iam.group_permissions WHERE group_id = $1`, [MASTER_ID])).rows.map((r) => r.permission_id).sort();
      expect(depois).toEqual(antes);
    });
  });

  describe('grant_country / revoke_country', () => {
    afterEach(async () => {
      await pool.query(`DELETE FROM iam.group_country_scopes WHERE group_id = $1 AND country = 'AR'`, [MASTER_ID]);
    });

    it('outsider → 42501 em grant_country, e nada é gravado', async () => {
      await expect(
        asActor(U.outsider, (c) => c.query(`SELECT iam.grant_country($1, 'AR', NULL)`, [MASTER_ID])),
      ).rejects.toMatchObject({ code: '42501' });
      const r = await pool.query(`SELECT 1 FROM iam.group_country_scopes WHERE group_id = $1 AND country = 'AR' AND revoked_at IS NULL`, [MASTER_ID]);
      expect(r.rowCount).toBe(0);
    });

    it('membro do Master → grant_country aceito; outsider tentando revoke_country → 42501; membro do Master revoga', async () => {
      await asActor(U.master, (c) => c.query(`SELECT iam.grant_country($1, 'AR', NULL)`, [MASTER_ID]));
      let r = await pool.query(`SELECT 1 FROM iam.group_country_scopes WHERE group_id = $1 AND country = 'AR' AND revoked_at IS NULL`, [MASTER_ID]);
      expect(r.rowCount).toBe(1);

      await expect(
        asActor(U.outsider, (c) => c.query(`SELECT iam.revoke_country($1, 'AR')`, [MASTER_ID])),
      ).rejects.toMatchObject({ code: '42501' });
      r = await pool.query(`SELECT 1 FROM iam.group_country_scopes WHERE group_id = $1 AND country = 'AR' AND revoked_at IS NULL`, [MASTER_ID]);
      expect(r.rowCount).toBe(1); // outsider não conseguiu revogar

      await asActor(U.master, (c) => c.query(`SELECT iam.revoke_country($1, 'AR')`, [MASTER_ID]));
      r = await pool.query(`SELECT 1 FROM iam.group_country_scopes WHERE group_id = $1 AND country = 'AR' AND revoked_at IS NULL`, [MASTER_ID]);
      expect(r.rowCount).toBe(0);
    });
  });

  describe('add_member / remove_member', () => {
    it('outsider → 42501 em add_member, e o alvo não entra no Master', async () => {
      await expect(
        asActor(U.outsider, (c) => c.query(`SELECT iam.add_member($1, $2)`, [MASTER_ID, U.alvo])),
      ).rejects.toMatchObject({
        code: '42501',
        message: expect.stringContaining('não é membro vivo do Acesso Master'),
      });
      const r = await pool.query(`SELECT 1 FROM iam.user_groups WHERE user_id = $1 AND group_id = $2 AND removed_at IS NULL`, [U.alvo, MASTER_ID]);
      expect(r.rowCount).toBe(0);
    });

    it('membro do Master → add_member aceito; outsider tentando remove_member → 42501; membro do Master remove', async () => {
      await asActor(U.master, (c) => c.query(`SELECT iam.add_member($1, $2)`, [MASTER_ID, U.alvo]));
      let r = await pool.query(`SELECT 1 FROM iam.user_groups WHERE user_id = $1 AND group_id = $2 AND removed_at IS NULL`, [U.alvo, MASTER_ID]);
      expect(r.rowCount).toBe(1);

      await expect(
        asActor(U.outsider, (c) => c.query(`SELECT iam.remove_member($1, $2)`, [MASTER_ID, U.alvo])),
      ).rejects.toMatchObject({ code: '42501' });
      r = await pool.query(`SELECT 1 FROM iam.user_groups WHERE user_id = $1 AND group_id = $2 AND removed_at IS NULL`, [U.alvo, MASTER_ID]);
      expect(r.rowCount).toBe(1); // outsider não conseguiu remover

      await asActor(U.master, (c) => c.query(`SELECT iam.remove_member($1, $2)`, [MASTER_ID, U.alvo]));
      r = await pool.query(`SELECT 1 FROM iam.user_groups WHERE user_id = $1 AND group_id = $2 AND removed_at IS NULL`, [U.alvo, MASTER_ID]);
      expect(r.rowCount).toBe(0);
    });
  });

  describe('o guard NÃO se aplica a outros grupos (nem is_system em geral)', () => {
    it('outsider consegue alterar o Super Admin (is_system, mas NÃO é o Acesso Master) — guard é só do Master', async () => {
      const antes = (await pool.query<{ description: string | null }>(`SELECT description FROM iam.permission_groups WHERE id = $1`, [superAdminId])).rows[0].description;
      await asActor(U.outsider, (c) => c.query(`SELECT iam.update_group($1, 'Super Admin', 'e2e-456-super-admin-ok')`, [superAdminId]));
      const depois = (await pool.query<{ description: string | null }>(`SELECT description FROM iam.permission_groups WHERE id = $1`, [superAdminId])).rows[0].description;
      expect(depois).toBe('e2e-456-super-admin-ok');
      await asActor(U.outsider, (c) => c.query(`SELECT iam.update_group($1, 'Super Admin', $2)`, [superAdminId, antes]));
    });
  });
});
