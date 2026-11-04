/**
 * agent-directory-http-078.e2e.test.ts — spec 078, M2: `GET /api/admin/users?forGroupId=` por HTTP REAL (cadeia do index.ts: mock auth -> AuthMiddleware ->
 * PermissionMiddleware com a família `admin.users` ENFORÇADA -> AdminController real -> AdminRepository), Postgres REAL como `app_runtime`.
 * Grupo `AGENT` -> só contas `agent`; grupo `INTERNAL` -> só staff; sem o param (e com lixo no param) -> o comportamento de sempre (staff). Prefixo `agh078`.
 */
import { Pool } from 'pg';
import { ensureLoginRole, dropLoginRoles, urlFor } from './helpers/loginRoles';
import { TENANT_E2E, tokenMock, montarAppDeFamilia, limparIamFixtures, type AppDeFamilia } from './helpers/permissionFamilyHarness';

const ADMIN_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RT = 'agh078_rt';
const PW = 'agh078_pw';
const GESTORA = 'agh078-gestora';
const STAFF = 'agh078-staff';
const GRUPO = 'AGH078 gestao';

describe('GET /api/admin/users?forGroupId — diretório por classe do grupo (HTTP real, banco real, app_runtime)', () => {
  let admin: Pool;
  let app: AppDeFamilia;
  let grupoAgent: string;
  let grupoInternal: string;
  const envAnterior: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string): void => {
    if (!(k in envAnterior)) envAnterior[k] = process.env[k];
    process.env[k] = v;
  };

  async function listar(query: string): Promise<{ status: number; admins: Array<{ firebaseUid: string; accountType?: string }> }> {
    const res = await fetch(`${app.url}/api/admin/users?limit=200${query}`, { headers: { Authorization: tokenMock(GESTORA, 'admin') } });
    const body = (await res.json().catch(() => ({}))) as { data?: Array<{ firebaseUid: string }> };
    return { status: res.status, admins: body.data ?? [] };
  }
  const limpar = (): Promise<void> => limparIamFixtures(admin, { uids: [GESTORA, STAFF], grupos: [GRUPO] });

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await ensureLoginRole(admin, RT, PW, 'app_runtime');
    await limpar();
    await admin.query(
      `INSERT INTO users (firebase_uid, email, display_name, role, account_type, status, is_active, tenant_id) VALUES
         ($1, 'agh078-gestora@enlite-e2e.local', 'AGH078 Gestora', 'admin', 'staff', 'ACTIVE', true, $3),
         ($2, 'agh078-staff@enlite-e2e.local', 'AGH078 Staff', 'admin', 'staff', 'ACTIVE', true, $3)`,
      [GESTORA, STAFF, TENANT_E2E],
    );
    const g = (await admin.query(`INSERT INTO iam.permission_groups (tenant_id, name, description) VALUES ($1, $2, 'e2e') RETURNING id`, [TENANT_E2E, GRUPO])).rows[0].id;
    const c = await admin.query(`INSERT INTO iam.group_permissions (group_id, permission_id) SELECT $1, id FROM iam.permissions WHERE resource = 'user_management' AND action = 'read' RETURNING 1`, [g]);
    if (c.rowCount !== 1) throw new Error('user_management:read ausente do catálogo');
    await admin.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [GESTORA, g, TENANT_E2E]);
    grupoAgent = (await admin.query(`SELECT id FROM iam.permission_groups WHERE actor_class = 'AGENT' AND archived_at IS NULL LIMIT 1`)).rows[0].id;
    grupoInternal = (await admin.query(`SELECT id FROM iam.permission_groups WHERE actor_class = 'INTERNAL' AND archived_at IS NULL AND name <> $1 LIMIT 1`, [GRUPO])).rows[0].id;

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.users');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', urlFor(ADMIN_URL, RT, PW));

    const { createAdminUsersRoutes } = await import('@modules/identity');
    const { AdminController } = await import('../../src/modules/identity/interfaces/controllers/AdminController');
    const controller = new AdminController();
    app = await montarAppDeFamilia({
      montarRotas: ({ app: express, auth, permissions }) => express.use('/api/admin', createAdminUsersRoutes(controller, auth, permissions)),
    });
  }, 60000);

  afterAll(async () => {
    await app?.fechar();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await limpar();
    await dropLoginRoles(admin, [RT]).catch(() => undefined);
    await admin.end();
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('forGroupId de grupo AGENT -> 200 só com contas agent (agent:luz presente, nenhum staff)', async () => {
    const r = await listar(`&forGroupId=${grupoAgent}`);
    expect(r.status).toBe(200);
    const uids = r.admins.map((a) => a.firebaseUid);
    expect(uids).toContain('agent:luz');
    expect(uids).not.toContain(STAFF);
    expect(uids).not.toContain(GESTORA);
  });

  it('forGroupId de grupo INTERNAL -> 200 só staff (controle positivo: staff semeado presente, agent:luz ausente)', async () => {
    const r = await listar(`&forGroupId=${grupoInternal}`);
    expect(r.status).toBe(200);
    const uids = r.admins.map((a) => a.firebaseUid);
    expect(uids).toContain(STAFF);
    expect(uids).not.toContain('agent:luz');
  });

  it('sem o param (e com lixo no param) -> o de sempre: staff, sem agente', async () => {
    for (const q of ['', '&forGroupId=nao-e-uuid']) {
      const r = await listar(q);
      expect(r.status).toBe(200);
      const uids = r.admins.map((a) => a.firebaseUid);
      expect(uids).toContain(STAFF);
      expect(uids).not.toContain('agent:luz');
    }
  });
});
