/**
 * assistants-platform-080.e2e.test.ts — spec 080, phase A, T061 (part 1): the TWO identities, the reach and the 1st key
 * (items 7 and 9) against REAL POSTGRES and real HTTP, with the PERMISSION ENGINE ON (`admin.integrations`) and the catalog
 * sync ON. Contract: `rotas-plataforma-novas.md` §0, §1, §5.
 *
 * Proves: (1) the 12 new cells enter the catalog WITHOUT a migration and only the Acesso Master has them; (2) the Master sees the 3
 * assistants and the 8 compartments in the reach, whoever lacks `assistant_maria:chat` does not see `maria`; (3) service only, person only or
 * both -> 401/401/200; (4) without the cell -> 403 on the scoreboard and on the escalation (the 1st key belongs to the platform); (5) a Master-only
 * cell does not enter a regular group (422) and the account stays 403.
 * Service identity: test token `mock_<base64>` accepted ONLY under USE_MOCK_AUTH=true (ServiceIdentityVerifier).
 * 100% SYNTHETIC data (`qa.080.*@enlite.test`); cleanup uses the admin connection. No network to Google/Vertex/KMS.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import {
  TENANT_E2E,
  montarAppComTodasFamilias,
  limparIamFixtures,
  grupoComCelulas,
  type AppComTodasFamilias,
} from './helpers/permissionFamilyHarness';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const MASTER_ID = 'a0000000-0000-0000-0000-000000000001';
const PROJECT = 'plat080-e2e';
const SA = `assistants-service-sa@${PROJECT}.iam.gserviceaccount.com`;
const AUDIENCE = 'https://api.enlite.health/assistentes';
const RUN = Date.now().toString(36);

const NEW_CELLS: Array<[string, string]> = [
  ['assistant_maria', 'chat'],
  ['assistant_lucero', 'chat'],
  ['assistant_candela', 'chat'],
  ['assistant_scoreboard', 'read'],
  ['assistant_escalation', 'register'],
  ...['public', 'recruitment', 'clinical', 'financial', 'management', 'coordination', 'technical'].map(
    (k) => [`knowledge_${k}`, 'read'] as [string, string],
  ),
];
/** The reach answers the compartment as an enum value (SCREAMING_SNAKE_CASE); lowercase lives only inside the cell name. */
const COMPARTMENTS = ['PUBLIC', 'RECRUITMENT', 'CLINICAL', 'FINANCIAL', 'MANAGEMENT', 'COORDINATION', 'TECHNICAL', 'PRODUCT_MEETINGS'];

const U = {
  master: 'qa-080-master-' + RUN,
  regular: 'qa-080-comum-' + RUN, // staff with ONE arbitrary cell (dashboard:read), none of the new cells
};
const REGULAR_GROUP = `Qa080 Comum ${RUN}`;

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64');
/** PERSON identity (mockAuthMiddleware): synthetic e-mail `qa.080.*@enlite.test`, `country` claim required. */
const personAuth = (uid: string) =>
  `Bearer mock_${b64({ uid, email: `${uid.replace(/-/g, '.')}@enlite.test`, role: 'admin', country: 'AR' })}`;
/** SERVICE identity: test token of the ServiceIdentityVerifier (only under USE_MOCK_AUTH=true). */
const serviceAuth = (o: Partial<{ email: string; email_verified: boolean; aud: string }> = {}) =>
  `Bearer mock_${b64({ email: SA, email_verified: true, aud: AUDIENCE, ...o })}`;

describe('assistants platform — two identities, reach and the 1st key — real HTTP, real DB, engine ON (spec 080, T061)', () => {
  let admin: Pool;
  // Cells live in the catalog BEFORE this suite's boot sync (see afterAll).
  let liveCellIds: string[] = [];
  let app: AppComTodasFamilias;
  let regularGroupId: string;
  const previousEnv: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string): void => {
    if (!(k in previousEnv)) previousEnv[k] = process.env[k];
    process.env[k] = v;
  };

  async function http(
    method: string,
    path: string,
    h: { person?: string | null; service?: string | null },
    body?: unknown,
  ) {
    const res = await fetch(`${app.url}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(h.person ? { Authorization: personAuth(h.person) } : {}),
        ...(h.service ? { 'X-Enlite-Service': h.service } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
  }

  const SCOREBOARD = () => {
    const to = new Date();
    const from = new Date(to.getTime() - 7 * 86400000);
    return `/api/admin/assistants/scoreboard?operator=luz&from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;
  };
  /** Escalation body: LEGACY vocabulary (glossary §6.4). */
  const ESCALATION = {
    gestora: 'maria',
    operador: 'luz',
    area: 'recrutamento',
    caso: 'leve',
    regra_ref: 'regra-sintetica',
    janela_de: '2026-10-01',
    janela_ate: '2026-10-07',
    observacao: 'observacao sintetica',
  };

  const cleanIam = () => limparIamFixtures(admin, { uids: Object.values(U), grupos: [REGULAR_GROUP] });
  const cellsOf = async (groupId: string) =>
    (
      await admin.query(
        `SELECT p.resource || ':' || p.action AS k FROM iam.group_permissions gp JOIN iam.permissions p ON p.id = gp.permission_id
          WHERE gp.group_id = $1 ORDER BY 1`,
        [groupId],
      )
    ).rows.map((r) => r.k as string);

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });
    liveCellIds = (await admin.query(`SELECT id FROM iam.permissions WHERE deprecated_at IS NULL`)).rows.map((r) => r.id as string);
    await cleanIam();

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('GCP_PROJECT_ID', PROJECT);
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_CATALOG_SYNC_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.integrations');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);

    // Rollout marker — without it `runPermissionsBootTasks` refuses to boot with the engine on.
    await admin.query(
      `INSERT INTO iam.rollout_state (key, value, note) VALUES ('permission_groups_migrated', 'done', 'e2e-assistants-platform-080')
       ON CONFLICT (key) DO UPDATE SET value = 'done'`,
    );

    await admin.query(
      `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES
         ($1,'qa.080.master@enlite.test','admin','ACTIVE',true,$3), ($2,'qa.080.comum@enlite.test','admin','ACTIVE',true,$3)`,
      [U.master, U.regular, TENANT_E2E],
    );
    await admin.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [U.master, MASTER_ID, TENANT_E2E]);
    regularGroupId = await grupoComCelulas(admin, { nome: REGULAR_GROUP, uid: U.regular, celulas: [['dashboard', 'read']] });
    // SABOTAGEM-ANCORA

    const { createAdminAssistantsRoutes, createAssistantsPlatformController } = await import('../../src/modules/agentes');
    const { ENLITE_TENANT_ID } = await import('@modules/identity/permissions');
    app = await montarAppComTodasFamilias({
      internalSecret: 'e2e-assistants-platform-080-secret',
      montarRotas: ({ app: express, auth, permissions, modulo }) => {
        const resolveCells = async (uid: string) =>
          (await modulo.authz.execute({ uid, tenantId: ENLITE_TENANT_ID })).permissions;
        express.use('/api/admin', createAdminAssistantsRoutes(createAssistantsPlatformController(resolveCells), auth, permissions));
      },
    });
  }, 60000);

  afterAll(async () => {
    await app?.fechar();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await cleanIam();
    // The boot sync runs against a router with ONLY the assistants routes mounted, so it deprecates every other cell of the shared
    // catalog (`deprecate_missing_permission_cells`). Restore them, otherwise later suites get 403 missing_cell (backend-e2e never runs the sync).
    await admin.query(`UPDATE iam.permissions SET deprecated_at = NULL WHERE id = ANY($1::uuid[])`, [liveCellIds]);
    await admin.query(`DELETE FROM iam.rollout_state WHERE key = 'permission_groups_migrated'`);
    await admin.end();
    for (const [k, v] of Object.entries(previousEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('the 12 new cells exist in the DB catalog WITHOUT a migration (boot sync) and ONLY the Acesso Master has them', async () => {
    const keys = NEW_CELLS.map(([r, a]) => `${r}:${a}`);
    expect(keys).toHaveLength(12);
    const cat = await admin.query(
      `SELECT count(*)::int AS n FROM iam.permissions WHERE resource || ':' || action = ANY($1) AND deprecated_at IS NULL`,
      [keys],
    );
    expect(cat.rows[0].n).toBe(12);
    expect((await cellsOf(MASTER_ID)).filter((k) => keys.includes(k))).toEqual([...keys].sort());
    const others = await admin.query(
      `SELECT g.name FROM iam.group_permissions gp JOIN iam.permissions p ON p.id = gp.permission_id JOIN iam.permission_groups g ON g.id = gp.group_id
        WHERE p.resource || ':' || p.action = ANY($1) AND g.id <> $2`,
      [keys, MASTER_ID],
    );
    expect(others.rows).toEqual([]);
    // no migration touches them: the sync is the only path
    const dir = join(__dirname, '../../migrations');
    const touching = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .filter((f) => {
        const sql = readFileSync(join(dir, f), 'utf8');
        return /INSERT\s+INTO\s+iam\.permissions/i.test(sql) && /assistant_(maria|lucero|candela|scoreboard|escalation)|knowledge_(public|recruitment|clinical)/.test(sql);
      });
    expect(touching).toEqual([]);
    expect(readdirSync(dir).filter((f) => f.endsWith(".sql")).some((f) => /INSERT\s+INTO\s+iam\.permissions/i.test(readFileSync(join(dir, f), "utf8")))).toBe(true); // positive control: the filter sees a migration that inserts a cell
  });

  it('Acesso Master account: the reach returns the 3 assistants and the 8 compartments, in the order of the constants', async () => {
    const r = await http('GET', '/api/admin/assistants/reach', { person: U.master, service: serviceAuth() });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ uid: U.master, assistants: ['maria', 'lucero', 'candela'], knowledge: COMPARTMENTS });
  });

  it('account WITHOUT assistant_maria:chat: the reach does not bring maria (nor any assistant, nor compartment)', async () => {
    expect(await cellsOf(regularGroupId)).not.toContain('assistant_maria:chat');
    const r = await http('GET', '/api/admin/assistants/reach', { person: U.regular, service: serviceAuth() });
    expect(r.status).toBe(200);
    expect(r.body.assistants).not.toContain('maria');
    expect(r.body).toEqual({ uid: U.regular, assistants: [], knowledge: [] });
  });

  it('item 9 — two identities: service only -> 401; person only -> 401; both -> 200', async () => {
    const serviceOnly = await http('GET', '/api/admin/assistants/reach', { service: serviceAuth() });
    expect(serviceOnly.status).toBe(401);
    const personOnly = await http('GET', '/api/admin/assistants/reach', { person: U.master });
    expect(personOnly.status).toBe(401);
    expect(personOnly.body.error).toBe('SERVICE_NOT_AUTHENTICATED');
    const both = await http('GET', '/api/admin/assistants/reach', { person: U.master, service: serviceAuth() });
    expect(both.status).toBe(200);
    // scoreboard: the same rule (the Master person alone is also blocked)
    expect((await http('GET', SCOREBOARD(), { person: U.master })).status).toBe(401);
    expect((await http('GET', SCOREBOARD(), { person: U.master, service: serviceAuth() })).status).toBe(200);
  });

  it('invalid service identity (another audience, unverified e-mail, e-mail outside the allowlist) -> 401 even with the right person', async () => {
    for (const bad of [
      serviceAuth({ aud: 'https://another.audience' }),
      serviceAuth({ email_verified: false }),
      serviceAuth({ email: 'other-sa@other-project.iam.gserviceaccount.com' }),
    ]) {
      const r = await http('GET', '/api/admin/assistants/reach', { person: U.master, service: bad });
      expect(r.status).toBe(401);
      expect(r.body.error).toBe('SERVICE_NOT_AUTHENTICATED');
    }
  });

  it('item 7 — the 1st key belongs to the platform: without the cell -> 403 on the scoreboard and on the escalation (both identities valid)', async () => {
    const scoreboard = await http('GET', SCOREBOARD(), { person: U.regular, service: serviceAuth() });
    expect(scoreboard.status).toBe(403);
    const escalation = await http('POST', '/api/admin/assistants/escalations', { person: U.regular, service: serviceAuth() }, ESCALATION);
    expect(escalation.status).toBe(403);
    // control: with the cell (Master) the SAME request is not 403 — the 403 above comes from the cell, not from anything else
    expect((await http('GET', SCOREBOARD(), { person: U.master, service: serviceAuth() })).status).toBe(200);
  });

  it('non-Master -> 403/422: giving assistant_scoreboard:read to a regular group is refused (422 master_only_cell, 0 rows) and the account stays 403', async () => {
    const before = await cellsOf(regularGroupId);
    await expect(
      app.modulo.groups.setPermissions.execute({
        tenantId: TENANT_E2E,
        groupId: regularGroupId,
        cellKeys: ['dashboard:read', 'assistant_scoreboard:read'],
      }),
    ).rejects.toMatchObject({ code: 'master_only_cell' });
    const after = await cellsOf(regularGroupId);
    expect(after).toEqual(before);
    expect(after).not.toContain('assistant_scoreboard:read');
    const r = await http('GET', SCOREBOARD(), { person: U.regular, service: serviceAuth() });
    expect(r.status).toBe(403);
  });
});
