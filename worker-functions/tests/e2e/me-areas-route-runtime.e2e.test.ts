/**
 * me-areas-route-runtime.e2e.test.ts — `GET /v1/me/areas` com a API conectada COMO `app_runtime` (acesso-do-cliente, F1, T124).
 *
 * Por que existe: `me-areas-route.e2e.test.ts` roda como DONO (enlite_admin, superuser) e ignora RLS e GRANT — não pega
 * "grant faltando" nem "função sem SECURITY DEFINER". Em stg/prd a API é membro de `app_runtime` (sem superuser, sem dono).
 * Aqui o `DATABASE_URL` da API é de um login membro de `app_runtime` e o `DATABASE_SYSTEM_URL` de um membro de `app_system`
 * (padrão de `abac-admin-routes`), com `COUNTRY_RLS_ENABLED=true`; as sementes entram por um pool ADMIN à parte.
 * Cadeia real (correlation → dbSession → mockAuth → AuthMiddleware → rota) numa porta efêmera; só o Firebase Admin é dublê.
 * Fixtures sintéticas, sem PII; `iam.*` é append-only, então os uids levam sufixo aleatório por execução.
 */
import { randomBytes } from 'crypto';
import * as firebaseAdmin from 'firebase-admin';
import { Pool } from 'pg';
import { tokenMock, montarAppDeFamilia, TENANT_E2E, type AppDeFamilia } from './helpers/permissionFamilyHarness';
import { urlFor, ensureLoginRole, dropLoginRoles } from './helpers/loginRoles';

const ADMIN_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = randomBytes(4).toString('hex');
const uid = (n: string) => `e2e-mearea-rt-${RUN}-${n}`;
const PASSWORD = 'mearea_rt_e2e_pw';
const RUNTIME_USER = 'mearea_rt_runtime';
const SYSTEM_USER = 'mearea_rt_system';

type Claims = Record<string, unknown>;

describe('GET /v1/me/areas — API conectada como membro de app_runtime (acesso-do-cliente F1, T124)', () => {
  let admin: Pool;
  let app: AppDeFamilia;
  const claims = new Map<string, Claims>();
  const emailOf = (u: string) => `${u}@e2e.local`;
  const envAnterior: Record<string, string | undefined> = {};

  async function chamar(u: string, role: string): Promise<{ status: number; body: any }> {
    const res = await fetch(`${app.url}/v1/me/areas`, { headers: { Authorization: tokenMock(u, role, 'AR') } });
    const texto = await res.text();
    return { status: res.status, body: texto ? JSON.parse(texto) : {} };
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await ensureLoginRole(admin, RUNTIME_USER, PASSWORD, 'app_runtime');
    await ensureLoginRole(admin, SYSTEM_USER, PASSWORD, 'app_system');

    for (const k of ['DATABASE_URL', 'DATABASE_SYSTEM_URL', 'COUNTRY_RLS_ENABLED', 'USE_MOCK_AUTH', 'DB_POOL_MAX', 'DB_SYSTEM_POOL_MAX']) {
      envAnterior[k] = process.env[k];
    }
    process.env.DATABASE_URL = urlFor(ADMIN_URL, RUNTIME_USER, PASSWORD);
    process.env.DATABASE_SYSTEM_URL = urlFor(ADMIN_URL, SYSTEM_USER, PASSWORD);
    process.env.COUNTRY_RLS_ENABLED = 'true';
    process.env.USE_MOCK_AUTH = 'true';
    process.env.DB_POOL_MAX = '4';
    process.env.DB_SYSTEM_POOL_MAX = '2';

    jest.spyOn(firebaseAdmin, 'auth').mockImplementation((() => ({
      getUser: async (u: string) => ({ uid: u, email: emailOf(u), customClaims: claims.get(u) ?? {} }),
      setCustomUserClaims: async (u: string, c: Claims) => void claims.set(u, c),
      revokeRefreshTokens: async () => undefined,
    })) as never);

    app = await montarAppDeFamilia({
      montarRotas: ({ app: expressApp, auth }) => {
        const { createMeAreasRouter } = require('@modules/identity/interfaces/meAreasRoute');
        expressApp.use('/v1', createMeAreasRouter(auth.requireAuth(), require('@shared/database/DatabaseConnection').DatabaseConnection.getInstance().getPool()));
      },
    });
  }, 30000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await app?.fechar();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await admin.query(`DELETE FROM users WHERE firebase_uid LIKE $1`, [`e2e-mearea-rt-${RUN}-%`]);
    await admin.query(`DELETE FROM workers WHERE auth_uid LIKE $1`, [`e2e-mearea-rt-${RUN}-%`]);
    await dropLoginRoles(admin, [RUNTIME_USER, SYSTEM_USER]);
    await admin.end();
    for (const [k, v] of Object.entries(envAnterior)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  });

  it('controle: a API NÃO é dono nem superuser — é membro de app_runtime', async () => {
    const r = await admin.query(
      `SELECT rolsuper, pg_has_role($1, 'app_runtime', 'MEMBER') AS runtime,
              NOT EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = 'iam'::regnamespace AND pg_get_userbyid(relowner) = $1) AS nao_dono
         FROM pg_roles WHERE rolname = $1`,
      [RUNTIME_USER],
    );
    expect(r.rows[0]).toEqual({ rolsuper: false, runtime: true, nao_dono: true });
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    const quem = await DatabaseConnection.getInstance().getPool().query(`SELECT current_user AS u`);
    expect(quem.rows[0].u).toBe(RUNTIME_USER);
  });

  it('prestador → 200 com care·worker (lê workers sob RLS e iam.* por função)', async () => {
    const u = uid('worker');
    await admin.query(
      `INSERT INTO workers (id, auth_uid, email, phone, status, country, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'INCOMPLETE_REGISTER', 'AR', NOW(), NOW())`,
      [u, emailOf(u), `+5491102${RUN.slice(0, 4)}`],
    );
    const r = await chamar(u, 'worker');
    expect(r.status).toBe(200);
    expect(r.body.areas).toEqual([{ area: 'care', role: 'worker', entryRoute: '/' }]);
  });

  it('staff → 200 com backoffice·staff', async () => {
    const u = uid('staff');
    await admin.query(
      `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id)
       VALUES ($1, $2, 'admin', 'ACTIVE', true, $3)`,
      [u, emailOf(u), TENANT_E2E],
    );
    const r = await chamar(u, 'admin');
    expect(r.status).toBe(200);
    expect(r.body.areas).toEqual([{ area: 'backoffice', role: 'staff', entryRoute: '/admin' }]);
  });

  it('bootstrap de pessoa nova → 200 + tokenRefreshRequired; pessoa e login criados pela função', async () => {
    const u = uid('boot');
    const antes = (await admin.query(`SELECT count(*)::int AS n FROM iam.person_login WHERE uid = $1`, [u])).rows[0].n;
    expect(antes).toBe(0);
    const r = await chamar(u, 'worker');
    expect(r.status).toBe(200);
    expect(r.body.areas).toEqual([]);
    expect(r.body.tokenRefreshRequired).toBe(true);
    const depois = (await admin.query(`SELECT person_id FROM iam.person_login WHERE uid = $1`, [u])).rows;
    expect(depois).toHaveLength(1);
    expect(claims.get(u)!.pid).toBe(depois[0].person_id);
    expect((await chamar(u, 'worker')).body.tokenRefreshRequired).toBe(false);
  });

  it('aluno com vínculo gravado → 200 com learn·learner (iam.effective_area_memberships como runtime, 581)', async () => {
    const u = uid('aluno');
    const pid = (await admin.query(`SELECT iam.ensure_person('firebase', $1) AS p`, [u])).rows[0].p;
    await admin.query(`SELECT iam.grant_area_membership($1::uuid, 'learn', 'learner', $2)`, [pid, uid('ator')]);
    const r = await chamar(u, 'worker');
    expect(r.status).toBe(200);
    expect(r.body.areas).toEqual([{ area: 'learn', role: 'learner', entryRoute: null }]);
  });
});
