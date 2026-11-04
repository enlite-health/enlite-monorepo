/**
 * assistant-count-routes-085.e2e.test.ts — change 085 (Maria conta por cardapio de campos), T115: as rotas
 * `GET /api/admin/assistants/count/{workers,patients,vacancies}` com ABAC REAL (familias admin.workers/patients/vacancies ENFORCADAS),
 * o servico REAL (`createAssistantCountService`) e o banco como `app_runtime` (sem bypass de RLS): a rota roda no `withActorContext`
 * com a identidade do ator, nao como dono. Massa 100% sintetica (`qa.085.*@enlite.test`, prefixo `ac085`).
 * Nao liga CATALOG_SYNC: as celulas worker:read/patient:read/vacancy:read ja vivem no seed (grupoComCelulas falha alto se faltar), e o
 * sync deprecaria as demais celulas do catalogo compartilhado (ver 080).
 */
import { Pool } from 'pg';
import {
  TENANT_E2E,
  montarAppComTodasFamilias,
  limparIamFixtures,
  grupoComCelulas,
  type AppComTodasFamilias,
} from './helpers/permissionFamilyHarness';
import { ensureLoginRole, dropLoginRoles, urlFor } from './helpers/loginRoles';

const ADMIN_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const PROJECT = 'count085-e2e';
const SA = `assistants-service-sa@${PROJECT}.iam.gserviceaccount.com`;
const AUDIENCE = 'https://api.enlite.health/assistentes';
const RUN = Date.now().toString(36);
const P = 'ac085';
const PW = 'ac085_pw';
const RT = 'ac085_rt';
const SYS = 'ac085_sys';
const PAC = 'ee085100-0000-4000-8000-0000000000a1';
const PA = 'ee085100-0000-4000-8000-0000000000a2';
const JP = 'ee085100-0000-4000-8000-0000000000a3';

const U = {
  semCelula: `qa-085-sem-${RUN}`,
  leitor: `qa-085-leitor-${RUN}`, // worker:read + patient:read + vacancy:read + escopo AR
};
const G_SEM = `Qa085 Sem ${RUN}`;
const G_LEITOR = `Qa085 Leitor ${RUN}`;

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64');
const personAuth = (uid: string) =>
  `Bearer mock_${b64({ uid, email: `${uid.replace(/-/g, '.')}@enlite.test`, role: 'admin', country: 'AR' })}`;
const serviceAuth = () => `Bearer mock_${b64({ email: SA, email_verified: true, aud: AUDIENCE })}`;

const ENTIDADES: Array<{ entity: 'workers' | 'patients' | 'vacancies'; rota: string; groupBy: string }> = [
  { entity: 'workers', rota: '/api/admin/assistants/count/workers', groupBy: 'registration' },
  { entity: 'patients', rota: '/api/admin/assistants/count/patients', groupBy: 'stage' },
  { entity: 'vacancies', rota: '/api/admin/assistants/count/vacancies', groupBy: 'status' },
];
/** Supressao de celula pequena: 1-4 sai `{lt:5}`, >=5 `{value}`/`{gte}`; so `{value:0}` e zero. */
const naoZero = (t: Record<string, number>): boolean => 'lt' in t || 'gte' in t || (typeof t.value === 'number' && t.value >= 1);
const TOP_KEYS = ['as_of', 'entity', 'filters', 'group_by', 'groups', 'scope', 'total'];

describe('rotas de contagem da Maria — ABAC real, servico real, app_runtime (change 085, T115)', () => {
  let admin: Pool;
  let app: AppComTodasFamilias;
  let liveCellIds: string[] = [];
  const previousEnv: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string | undefined): void => {
    if (!(k in previousEnv)) previousEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };

  async function http(path: string, h: { person?: string | null; service?: string | null }) {
    const res = await fetch(`${app.url}${path}`, {
      headers: {
        ...(h.person ? { Authorization: personAuth(h.person) } : {}),
        ...(h.service ? { 'X-Enlite-Service': h.service } : {}),
      },
    });
    const text = await res.text();
    let body: Record<string, any> = {};
    try {
      body = JSON.parse(text);
    } catch {
      /* corpo nao-JSON: fica {} e o status decide */
    }
    return { status: res.status, text, body };
  }
  const ambos = (uid: string) => ({ person: uid, service: serviceAuth() });

  async function limpar(): Promise<void> {
    await admin.query(`DELETE FROM job_postings WHERE id = $1`, [JP]);
    await admin.query(`DELETE FROM patient_addresses WHERE id = $1`, [PA]);
    await admin.query(`DELETE FROM patients WHERE id = $1`, [PAC]);
    await admin.query(`DELETE FROM workers WHERE auth_uid LIKE '${P}-%'`);
    await admin.query(`DELETE FROM iam.group_country_scopes WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name = ANY($1))`, [[G_SEM, G_LEITOR]]);
    await limparIamFixtures(admin, { uids: Object.values(U), grupos: [G_SEM, G_LEITOR] });
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    liveCellIds = (await admin.query(`SELECT id FROM iam.permissions WHERE deprecated_at IS NULL`)).rows.map((r) => r.id as string);
    await limpar();
    await ensureLoginRole(admin, RT, PW, 'app_runtime');
    await ensureLoginRole(admin, SYS, PW, 'app_system');

    setEnv('DATABASE_URL', urlFor(ADMIN_URL, RT, PW));
    setEnv('DATABASE_SYSTEM_URL', urlFor(ADMIN_URL, SYS, PW));
    setEnv('COUNTRY_RLS_ENABLED', 'true');
    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('GCP_PROJECT_ID', PROJECT);
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.integrations,admin.workers,admin.patients,admin.vacancies');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');

    await admin.query(
      `INSERT INTO iam.rollout_state (key, value, note) VALUES ('permission_groups_migrated', 'done', 'e2e-count-085')
       ON CONFLICT (key) DO UPDATE SET value = 'done'`,
    );
    await admin.query(
      `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES
         ($1,'qa.085.sem@enlite.test','admin','ACTIVE',true,$3), ($2,'qa.085.leitor@enlite.test','admin','ACTIVE',true,$3)`,
      [U.semCelula, U.leitor, TENANT_E2E],
    );
    // "sem celula": staff com UMA celula arbitraria (dashboard:read) e pais AR — o 403 vem da celula, nao do pais
    const gSem = await grupoComCelulas(admin, { nome: G_SEM, uid: U.semCelula, celulas: [['dashboard', 'read']] });
    const gLeitor = await grupoComCelulas(admin, {
      nome: G_LEITOR,
      uid: U.leitor,
      celulas: [['worker', 'read'], ['patient', 'read'], ['vacancy', 'read']],
    });
    for (const g of [gSem, gLeitor]) {
      await admin.query(`INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason) VALUES ($1, 'AR', 'e2e', 'e2e')`, [g]);
    }

    // massa sintetica AR: 1 worker, 1 paciente, 1 vaga
    await admin.query(`INSERT INTO workers (auth_uid, email, status, country, phone) VALUES ($1, $2, 'REGISTERED', 'AR', '+5491155585001')`, [`${P}-w1`, `${P}-w1@e2e.local`]);
    await admin.query(`INSERT INTO patients (id, clickup_task_id, first_name, last_name, country) VALUES ($1, '${P}-p1', 'Pac', 'Sintetico', 'AR')`, [PAC]);
    await admin.query(`INSERT INTO patient_addresses (id, patient_id, country, city) VALUES ($1, $2, 'AR', 'Palermo')`, [PA, PAC]);
    await admin.query(
      `INSERT INTO job_postings (id, title, is_draft, status, patient_id, patient_address_id, case_number) VALUES ($1, $2, false, 'SEARCHING', $3, $4, 85001)`,
      [JP, `${P} vaga`, PAC, PA],
    );

    const { createAdminAssistantsRoutes, createAssistantsPlatformController, createAssistantCountService } = await import('../../src/modules/agentes');
    const { ENLITE_TENANT_ID } = await import('@modules/identity/permissions');
    const { resolveCountryScope } = await import('@modules/identity');
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    app = await montarAppComTodasFamilias({
      internalSecret: 'e2e-count-085-secret',
      montarRotas: ({ app: express, auth, permissions, modulo }) => {
        const resolveCells = async (uid: string) => (await modulo.authz.execute({ uid, tenantId: ENLITE_TENANT_ID })).permissions;
        express.use(
          '/api/admin',
          createAdminAssistantsRoutes(createAssistantsPlatformController(resolveCells), auth, permissions, {
            service: createAssistantCountService(),
            resolveCountries: async (uid, requested) => (await resolveCountryScope(DatabaseConnection.getInstance().getPool(), uid, requested)).countries,
          }),
        );
      },
    });
  }, 90000);

  afterAll(async () => {
    await app?.fechar();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await limpar();
    await admin.query(`UPDATE iam.permissions SET deprecated_at = NULL WHERE id = ANY($1::uuid[])`, [liveCellIds]);
    await admin.query(`DELETE FROM iam.rollout_state WHERE key = 'permission_groups_migrated'`);
    await dropLoginRoles(admin, [RT, SYS]).catch(() => undefined);
    await admin.end();
    for (const [k, v] of Object.entries(previousEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('a conexao do app e app_runtime sem bypass de RLS (a rota roda como o ator, nao como dono)', async () => {
    const r = await admin.query(`SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = $1`, [RT]);
    expect(r.rows).toEqual([{ rolname: RT, rolbypassrls: false, rolsuper: false }]);
    expect(process.env.DATABASE_URL).toContain(RT);
  });

  describe.each(ENTIDADES)('$entity', ({ entity, rota, groupBy }) => {
    it('(a/b) sem a celula de leitura -> 403 missing_cell; com ela -> 200 com total', async () => {
      const negado = await http(rota, ambos(U.semCelula));
      expect(negado.status).toBe(403);
      expect(negado.body.code).toBe('missing_cell');
      const ok = await http(rota, ambos(U.leitor));
      expect(ok.status).toBe(200);
      expect(ok.body.entity).toBe(entity);
      expect(ok.body.total).toBeDefined();
      // a massa semeada (1 AR) e visivel pela identidade do ator (RLS): contagem zero seria falha
      expect(naoZero(ok.body.total)).toBe(true);
    });

    it('(c) agrupado por campo do cardapio: shape fechado, sem UUID nem telefone no JSON', async () => {
      const r = await http(`${rota}?group_by=${groupBy}`, ambos(U.leitor));
      expect(r.status).toBe(200);
      expect(Object.keys(r.body).sort()).toEqual(TOP_KEYS);
      expect(r.body.group_by).toBe(groupBy);
      expect(r.text.length).toBeGreaterThan(50);
      expect(r.text.match(/[0-9a-f]{8}-[0-9a-f]{4}-/gi)).toBeNull();
      expect(r.text.match(/\+?\d{8,}/g)).toBeNull();
    });

    it('(d) filters com JSON invalido -> 400; campo fora do cardapio -> 400 com valid_fields', async () => {
      const ruim = await http(`${rota}?filters=${encodeURIComponent('{nao-json')}`, ambos(U.leitor));
      expect(ruim.status).toBe(400);
      const fora = await http(`${rota}?filters=${encodeURIComponent(JSON.stringify([{ field: 'campo_x', values: ['a'] }]))}`, ambos(U.leitor));
      expect(fora.status).toBe(400);
      expect(Array.isArray(fora.body.valid_fields)).toBe(true);
      expect(fora.body.valid_fields.length).toBeGreaterThan(0);
      expect(fora.body.valid_fields).toContain(groupBy);
    });

    it('(e) sem o header de servico -> 401 SERVICE_NOT_AUTHENTICATED, mesmo com a pessoa certa', async () => {
      const r = await http(rota, { person: U.leitor });
      expect(r.status).toBe(401);
      expect(r.body.error).toBe('SERVICE_NOT_AUTHENTICATED');
    });
  });

  it('(f) pacientes via withActorContext real: o ator AR ve o paciente AR; e a RLS recorta o que nao e do pais dele', async () => {
    const r = await http('/api/admin/assistants/count/patients', ambos(U.leitor));
    expect(r.status).toBe(200);
    expect(naoZero(r.body.total)).toBe(true);
    // pais fora do escopo do ator -> negado (resolveCountryScope), nunca contagem de outro pais
    const br = await http('/api/admin/assistants/count/patients?country=BR', ambos(U.leitor));
    expect(br.status).toBe(403);
  });
});
