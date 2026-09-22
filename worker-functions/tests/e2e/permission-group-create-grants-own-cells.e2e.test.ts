/**
 * permission-group-create-grants-own-cells.e2e.test.ts — R4-2 (change 022-ux-mencao-e-notificacao,
 * Rodada 4, pedido do Gabriel 22/09): prova o lado ESTRUTURAL do achado de prd (145 DENY de
 * `own_presence:update` em 6h — grupo criado no painel nascia sem `own_*`).
 *
 * HTTP real (`permissionFamilyHarness.ts`), Postgres real, engine ABAC LIGADO. Caminho
 * REAL de ponta a ponta — nada de fixture direta em `iam.group_permissions` para o grupo sob
 * teste (isso provaria só o SQL, não o caminho do painel):
 *
 *   1. POST /api/admin/permission-groups (rota real, `iam.create_group`, migration 469) cria o
 *      grupo — sem QUALQUER célula pedida no corpo.
 *   2. Confere no banco que o grupo NASCEU com own_notifications:read/update e
 *      own_presence:update — sem nenhuma migration de catch-up ter rodado depois.
 *   3. POST /api/admin/permission-groups/:id/members (rota real, `iam.add_member`) põe uma
 *      pessoa NOVA no grupo.
 *   4. Essa pessoa, com ABAC ligado, consegue POST /api/admin/me/presence (204) e
 *      POST /api/admin/notifications/read-all (200) — as duas rotas que a migration 467/468
 *      corrigiram para os grupos ANTIGOS. Aqui é o grupo NOVO, provando que R4-2 evita reabrir
 *      o mesmo incidente no próximo grupo criado.
 */
import { Pool } from 'pg';
import {
  montarAppDeFamilia,
  tokenMock,
  grupoComCelulas,
  limparIamFixtures,
  TENANT_E2E,
  type AppDeFamilia,
} from './helpers/permissionFamilyHarness';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5442/enlite_e2e';

describe('Criação de grupo concede own_* automaticamente (spec 022, Rodada 4, R4-2) — HTTP real, Postgres real, engine ligado', () => {
  let pool: Pool;
  let app: AppDeFamilia;
  const COUNTRY = 'AR';

  const GESTOR = 'e022-r4-gestor';
  const MEMBRO_NOVO = 'e022-r4-membro-novo-grupo';
  const GRUPO_GESTAO = 'E022 R4 Gestão (ator)';
  const NOME_GRUPO_NOVO = 'E022 R4 Grupo Criado Pelo Painel';

  let idGrupoNovo: string;

  const envAnterior: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string): void => {
    envAnterior[k] = process.env[k];
    process.env[k] = v;
  };

  async function chamar(
    metodo: string,
    caminho: string,
    uid: string,
    body?: unknown,
  ): Promise<{ status: number; body: any }> {
    const res = await fetch(`${app.url}${caminho}`, {
      method: metodo,
      headers: { Authorization: tokenMock(uid, 'admin', COUNTRY), 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  async function celulasDoGrupo(groupId: string): Promise<Array<{ resource: string; action: string }>> {
    const r = await pool.query<{ resource: string; action: string }>(
      `SELECT p.resource, p.action
         FROM iam.group_permissions gp
         JOIN iam.permissions p ON p.id = gp.permission_id
        WHERE gp.group_id = $1
        ORDER BY 1, 2`,
      [groupId],
    );
    return r.rows;
  }

  async function limpar(): Promise<void> {
    const doTeste = `(SELECT id FROM iam.permission_groups WHERE name LIKE 'E022 R4%')`;
    await pool.query(`DELETE FROM iam.permission_audit_log WHERE user_id = ANY($1)`, [[GESTOR, MEMBRO_NOVO]]);
    await pool.query(`DELETE FROM iam.permission_group_changes WHERE group_id IN ${doTeste}`);
    await pool.query(`DELETE FROM iam.group_permissions WHERE group_id IN ${doTeste}`);
    await pool.query(`DELETE FROM iam.user_groups WHERE group_id IN ${doTeste}`);
    await pool.query(`DELETE FROM iam.permission_groups WHERE name LIKE 'E022 R4%'`);
    await pool.query(`DELETE FROM staff_presence WHERE firebase_uid = ANY($1)`, [[GESTOR, MEMBRO_NOVO]]);
    await limparIamFixtures(pool, { uids: [GESTOR, MEMBRO_NOVO], grupos: [] });
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();

    await pool.query(
      `INSERT INTO users (firebase_uid, email, display_name, role, status, tenant_id) VALUES
         ($1, 'e022-r4-gestor@e2e.local', 'R4 Gestor', 'admin', 'ACTIVE', $3),
         ($2, 'e022-r4-membro-novo@e2e.local', 'R4 Membro Novo', 'admin', 'ACTIVE', $3)`,
      [GESTOR, MEMBRO_NOVO, TENANT_E2E],
    );

    // O ATOR que cria o grupo precisa de permission_management:write — fixture normal
    // (grupoComCelulas), igual a `permission-panel-write-api.e2e.test.ts`. Isto NÃO é o grupo
    // sob teste — o grupo sob teste nasce só pela chamada HTTP do teste 1, sem fixture nenhuma.
    await grupoComCelulas(pool, {
      nome: GRUPO_GESTAO,
      uid: GESTOR,
      celulas: [['permission_management', 'write'], ['permission_management', 'read']],
    });

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.users');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);

    const { createPermissionPanelWriteRoutes } = await import('@modules/identity');
    const { createAdminPresenceRoutes } = await import(
      '../../src/modules/presence/interfaces/routes/adminPresenceRoutes'
    );
    const { createAdminNotificationRoutes } = await import(
      '../../src/modules/inapp-notification/interfaces/routes/adminNotificationRoutes'
    );

    app = await montarAppDeFamilia({
      enforcedRoutes: 'admin.users',
      montarRotas: ({ app: express, auth, permissions, modulo }) => {
        express.use('/api/admin', createPermissionPanelWriteRoutes({ writer: modulo, auth, permissions, tenantId: TENANT_E2E }));
        express.use('/api/admin', createAdminPresenceRoutes(auth, permissions));
        express.use('/api/admin', createAdminNotificationRoutes(auth, permissions, modulo.client));
      },
    });
  }, 60000);

  afterAll(async () => {
    await app?.fechar();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await limpar();
    await pool.end();
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('1. POST /api/admin/permission-groups cria o grupo SEM pedir nenhuma célula no corpo', async () => {
    const res = await chamar('POST', '/api/admin/permission-groups', GESTOR, {
      name: NOME_GRUPO_NOVO,
      description: 'criado pelo e2e da Rodada 4 — sem célula no corpo',
    });
    expect(res.status).toBe(200);
    expect(res.body.groupId).toEqual(expect.any(String));
    idGrupoNovo = res.body.groupId;
  });

  it('2. o grupo NASCE com own_notifications:read/update e own_presence:update — sem catch-up rodar (R4-2)', async () => {
    const celulas = await celulasDoGrupo(idGrupoNovo);
    expect(celulas).toEqual([
      { resource: 'own_notifications', action: 'read' },
      { resource: 'own_notifications', action: 'update' },
      { resource: 'own_presence', action: 'update' },
    ]);
  });

  it('3. POST /api/admin/permission-groups/:id/members põe o membro novo no grupo recém-criado', async () => {
    const res = await chamar('POST', `/api/admin/permission-groups/${idGrupoNovo}/members`, GESTOR, {
      userId: MEMBRO_NOVO,
    });
    expect(res.status).toBe(200);
    const r = await pool.query(
      `SELECT 1 FROM iam.user_groups WHERE group_id = $1 AND user_id = $2 AND removed_at IS NULL`,
      [idGrupoNovo, MEMBRO_NOVO],
    );
    expect(r.rowCount).toBe(1);
  });

  it('4. o membro do grupo NOVO consegue POST /api/admin/me/presence — 204, sem precisar de catch-up (o bug medido em prd, fechado pela raiz)', async () => {
    const res = await chamar('POST', '/api/admin/me/presence', MEMBRO_NOVO);
    expect(res.status).toBe(204);

    const r = await pool.query(`SELECT last_seen_at FROM staff_presence WHERE firebase_uid = $1`, [MEMBRO_NOVO]);
    expect(r.rows[0]?.last_seen_at).not.toBeNull();
  });

  it('5. o membro do grupo NOVO consegue POST /api/admin/notifications/read-all — 200 (own_notifications:update presente desde a criação)', async () => {
    const res = await chamar('POST', '/api/admin/notifications/read-all', MEMBRO_NOVO);
    expect(res.status).toBe(200);
    expect(res.body.data.updated).toBe(0); // nenhuma notificação pendente — o que importa é NÃO ser 403
  });
});
