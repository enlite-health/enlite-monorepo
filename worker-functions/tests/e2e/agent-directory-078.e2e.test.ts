/**
 * agent-directory-078.e2e.test.ts — spec 078, M2 (lote 3): o diretório do seletor de membro do painel, contra Postgres REAL como `app_runtime`.
 * `agent:luz` (semeada pela 556) aparece como candidata SÓ no grupo de classe `AGENT`; no grupo `INTERNAL` e sem contexto aparece só o staff
 * (controle positivo: um staff semeado aparece no INTERNAL). Dados sintéticos, prefixo `agd078`.
 */
import { Pool } from 'pg';
import { ensureLoginRole, dropLoginRoles, urlFor } from './helpers/loginRoles';

const ADMIN_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RT = 'agd078_rt';
const PW = 'agd078_pw';
const STAFF = 'agd078-staff';
const TENANT = '00000000-0000-0000-0000-000000000001';

describe('diretório do painel × classe do grupo (HTTP-less, banco real, role app_runtime)', () => {
  let admin: Pool;
  let repo: import('../../src/modules/identity/infrastructure/AdminRepository').AdminRepository;
  let grupoAgent: string;
  let grupoInternal: string;
  const envAnterior = process.env.DATABASE_URL;

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await ensureLoginRole(admin, RT, PW, 'app_runtime');
    await admin.query(`DELETE FROM users WHERE firebase_uid = $1`, [STAFF]);
    await admin.query(
      `INSERT INTO users (firebase_uid, email, display_name, role, account_type, status, is_active, tenant_id)
       VALUES ($1, 'agd078-staff@enlite-e2e.local', 'AGD078 Staff', 'admin', 'staff', 'ACTIVE', true, $2)`,
      [STAFF, TENANT],
    );
    grupoAgent = (await admin.query(`SELECT id FROM iam.permission_groups WHERE actor_class = 'AGENT' AND archived_at IS NULL LIMIT 1`)).rows[0].id;
    grupoInternal = (await admin.query(`SELECT id FROM iam.permission_groups WHERE actor_class = 'INTERNAL' AND archived_at IS NULL LIMIT 1`)).rows[0].id;
    process.env.DATABASE_URL = urlFor(ADMIN_URL, RT, PW);
    const { AdminRepository } = await import('../../src/modules/identity/infrastructure/AdminRepository');
    repo = new AdminRepository();
  }, 60000);

  afterAll(async () => {
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await admin.query(`DELETE FROM users WHERE firebase_uid = $1`, [STAFF]);
    await dropLoginRoles(admin, [RT]).catch(() => undefined);
    await admin.end();
    if (envAnterior === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = envAnterior;
  });

  it('a conexão é app_runtime sem bypass de RLS (declarada)', async () => {
    const r = await admin.query(`SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = $1`, [RT]);
    expect(r.rows).toEqual([{ rolname: RT, rolbypassrls: false, rolsuper: false }]);
  });

  it('grupo AGENT: agent:luz aparece (e só contas agent); nenhum staff', async () => {
    const r = await repo.listAdmins(200, 0, grupoAgent);
    const uids = r.admins.map((a) => a.firebaseUid);
    expect(uids).toContain('agent:luz');
    expect(uids).not.toContain(STAFF);
    expect(r.admins.every((a) => a.accountType === 'agent')).toBe(true);
  });

  it('grupo INTERNAL: o staff aparece (controle positivo) e agent:luz NÃO', async () => {
    const r = await repo.listAdmins(200, 0, grupoInternal);
    const uids = r.admins.map((a) => a.firebaseUid);
    expect(uids).toContain(STAFF);
    expect(uids).not.toContain('agent:luz');
  });

  it('sem contexto e com id de grupo inexistente: igual ao INTERNAL — o agente nunca aparece', async () => {
    for (const ctx of [undefined, '00000000-0000-4000-8000-00000000dead']) {
      const r = await repo.listAdmins(200, 0, ctx);
      const uids = r.admins.map((a) => a.firebaseUid);
      expect(uids).toContain(STAFF);
      expect(uids).not.toContain('agent:luz');
    }
  });
});
