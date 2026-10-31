/**
 * assistants-platform-080-write.e2e.test.ts — spec 080, phase A, T063 (part 2): scoreboard, "Llevar al Sol" escalation and the
 * absence of an assistant prompt (items 25 and 29c) against REAL POSTGRES and real HTTP, ENGINE ON, catalog sync ON.
 * Contract: `rotas-plataforma-novas.md` §2, §3, §6. Mold: `assistants-platform-080.e2e.test.ts` (part 1; the small helpers
 * were repeated on purpose: extracting a shared helper was not worth the jest-and-tsc memory risk).
 *
 * FIXTURE: Master-only cells do not enter a regular group through the app (422). The "escalation without chat" group is built by
 * a direct INSERT into the stack DB (`grupoComCelulas`): only `assistant_escalation:register`, WITHOUT `assistant_maria:chat`.
 * 100% SYNTHETIC data (operator `qa080-*`, accounts `qa.080w.*@enlite.test`), no conversation text and no PII.
 */
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

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64');
/** PERSON identity (mockAuthMiddleware): synthetic e-mail `qa.080.*@enlite.test`, `country` claim required. */
const personAuth = (uid: string) =>
  `Bearer mock_${b64({ uid, email: `${uid.replace(/-/g, '.')}@enlite.test`, role: 'admin', country: 'AR' })}`;
/** SERVICE identity: test token of the ServiceIdentityVerifier (only under USE_MOCK_AUTH=true). */
const serviceAuth = (o: Partial<{ email: string; email_verified: boolean; aud: string }> = {}) =>
  `Bearer mock_${b64({ email: SA, email_verified: true, aud: AUDIENCE, ...o })}`;

const OPERATOR = `qa080-${RUN}`.slice(0, 40);
const U2 = {
  master: 'qa-080w-master-' + RUN,
  nochat: 'qa-080w-semchat-' + RUN, // has assistant_escalation:register, does NOT have assistant_maria:chat
};
const NOCHAT_GROUP = `Qa080w SemChat ${RUN}`;

describe('assistants platform — scoreboard, escalation and no assistant prompt — real HTTP, real DB (spec 080, T063)', () => {
  let admin: Pool;
  let app: AppComTodasFamilias;
  const previousEnv: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string): void => {
    if (!(k in previousEnv)) previousEnv[k] = process.env[k];
    process.env[k] = v;
  };

  async function http(method: string, path: string, h: { person?: string | null; service?: string | null }, body?: unknown) {
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
    const now = Date.now();
    const from = new Date(now - 86400000).toISOString();
    const to = new Date(now + 86400000).toISOString();
    return `/api/admin/assistants/scoreboard?operator=${OPERATOR}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  };
  /** Escalation body: LEGACY vocabulary (glossary §6.4); the response body is legacy too (`duplicado`). */
  const ESCALATION = {
    gestora: 'maria',
    operador: OPERATOR,
    area: 'recrutamento',
    caso: 'leve',
    regra_ref: 'regra-sintetica',
    janela_de: '2026-10-01',
    janela_ate: '2026-10-07',
    observacao: 'observacao sintetica',
  };
  const countEscalations = async (): Promise<number> =>
    (await admin.query(`SELECT count(*)::int AS n FROM agentes.reportes WHERE operador = $1`, [OPERATOR])).rows[0].n;

  const cleanAgentes = async () => {
    await admin.query(`DELETE FROM agentes.reporte_veredictos WHERE reporte_id IN (SELECT id FROM agentes.reportes WHERE operador = $1)`, [OPERATOR]);
    await admin.query(`DELETE FROM agentes.reportes WHERE operador = $1`, [OPERATOR]);
    await admin.query(`DELETE FROM agentes.veredicto_achados WHERE veredicto_id IN (SELECT id FROM agentes.veredictos WHERE operador = $1)`, [OPERATOR]);
    await admin.query(`DELETE FROM agentes.veredictos WHERE operador = $1`, [OPERATOR]);
  };
  const cleanIam = () => limparIamFixtures(admin, { uids: Object.values(U2), grupos: [NOCHAT_GROUP] });

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });
    await cleanAgentes();
    await cleanIam();

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('GCP_PROJECT_ID', PROJECT);
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_CATALOG_SYNC_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.integrations');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);

    await admin.query(
      `INSERT INTO iam.rollout_state (key, value, note) VALUES ('permission_groups_migrated', 'done', 'e2e-assistants-platform-080-write')
       ON CONFLICT (key) DO UPDATE SET value = 'done'`,
    );
    await admin.query(
      `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES
         ($1,'qa.080w.master@enlite.test','admin','ACTIVE',true,$3), ($2,'qa.080w.semchat@enlite.test','admin','ACTIVE',true,$3)`,
      [U2.master, U2.nochat, TENANT_E2E],
    );
    await admin.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [U2.master, MASTER_ID, TENANT_E2E]);

    const { createAdminAssistantsRoutes, createAssistantsPlatformController } = await import('../../src/modules/agentes');
    const { ENLITE_TENANT_ID } = await import('@modules/identity/permissions');
    app = await montarAppComTodasFamilias({
      internalSecret: 'e2e-assistants-platform-080-write-secret',
      montarRotas: ({ app: express, auth, permissions, modulo }) => {
        const resolveCells = async (uid: string) =>
          (await modulo.authz.execute({ uid, tenantId: ENLITE_TENANT_ID })).permissions;
        express.use('/api/admin', createAdminAssistantsRoutes(createAssistantsPlatformController(resolveCells), auth, permissions));
      },
    });
    // FIXTURE by direct INSERT (the app refuses a Master-only cell in a regular group): escalation only, WITHOUT assistant_maria:chat.
    // Runs AFTER the boot (the catalog sync creates the cells).
    await grupoComCelulas(admin, { nome: NOCHAT_GROUP, uid: U2.nochat, celulas: [['assistant_escalation', 'register']] });

    // Synthetic verdict (silent sensor: no grade, no text) + 1 violation finding
    const v = await admin.query(
      `INSERT INTO agentes.veredictos (operador, sensor, inbox, conversa_ref, ultima_msg_ref, cruza_areas)
       VALUES ($1,'silente','inbox-sintetica','conv-sintetica','msg-sintetica',true) RETURNING id`,
      [OPERATOR],
    );
    await admin.query(
      `INSERT INTO agentes.veredicto_achados (veredicto_id, tipo, regra_ref, gravidade) VALUES ($1,'violacao','regra-sintetica','media')`,
      [v.rows[0].id],
    );
  }, 60000);

  afterAll(async () => {
    await app?.fechar();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await cleanAgentes();
    await cleanIam();
    await admin.query(`DELETE FROM iam.rollout_state WHERE key = 'permission_groups_migrated'`);
    await admin.end();
    for (const [k, v] of Object.entries(previousEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('scoreboard with one seeded verdict: returns ONLY the contract §2 fields (no ids, no conversa_ref)', async () => {
    const r = await http('GET', SCOREBOARD(), { person: U2.master, service: serviceAuth() });
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['ate', 'conversas', 'cruza_areas', 'de', 'nota_media', 'operador', 'por_regra', 'veredictos']);
    expect(r.body).toMatchObject({ operador: OPERATOR, veredictos: 1, conversas: 1, cruza_areas: 1, nota_media: null });
    expect(r.body.por_regra).toEqual([{ regra_ref: 'regra-sintetica', violacoes: 1, gravidade_max: 'media' }]);
    expect(JSON.stringify(r.body)).not.toMatch(/"(texto|trecho|resumo|nome|telefone|conversa_ref|uid|email|actor|changed_by|veredicto_ids|graves|text|excerpt|summary|name|phone|conversation_ref)"/);
  });

  it('valid escalation -> 201 and the escalations table has 1 row (author, operator and kind mapped back to the legacy columns)', async () => {
    expect(await countEscalations()).toBe(0);
    const r = await http('POST', '/api/admin/assistants/escalations', { person: U2.master, service: serviceAuth() }, ESCALATION);
    expect(r.status).toBe(201);
    expect(typeof r.body.id).toBe('string');
    expect(r.body.duplicado).toBeUndefined();
    expect(await countEscalations()).toBe(1);
    const row = await admin.query(`SELECT autor, operador, caso FROM agentes.reportes WHERE id = $1`, [r.body.id]);
    expect(row.rows[0]).toEqual({ autor: 'maria', operador: OPERATOR, caso: 'leve' });
  });

  it('the same escalation again: the 2nd time returns duplicado and the count stays 1', async () => {
    expect(await countEscalations()).toBe(1);
    const r = await http('POST', '/api/admin/assistants/escalations', { person: U2.master, service: serviceAuth() }, ESCALATION);
    expect(r.status).toBe(200);
    expect(r.body.duplicado).toBe(true);
    expect(typeof r.body.id).toBe('string');
    expect(await countEscalations()).toBe(1);
  });

  it('observacao of 501 characters -> 400 and the count does not change (control: 500 characters passes)', async () => {
    const before = await countEscalations();
    const r = await http('POST', '/api/admin/assistants/escalations', { person: U2.master, service: serviceAuth() }, { ...ESCALATION, janela_de: '2026-10-08', janela_ate: '2026-10-09', observacao: 'a'.repeat(501) });
    expect(r.status).toBe(400);
    expect(await countEscalations()).toBe(before);
    // positive control: the SAME body with 500 characters is accepted (the 400 above comes from the size)
    const ok = await http('POST', '/api/admin/assistants/escalations', { person: U2.master, service: serviceAuth() }, { ...ESCALATION, janela_de: '2026-10-08', janela_ate: '2026-10-09', observacao: 'a'.repeat(500) });
    expect(ok.status).toBe(201);
    expect(await countEscalations()).toBe(before + 1);
  });

  it('account with assistant_escalation:register but WITHOUT assistant_maria:chat -> 403 and the count does not change', async () => {
    const { rows } = await admin.query(
      `SELECT p.resource || ':' || p.action AS k FROM iam.user_groups ug JOIN iam.group_permissions gp ON gp.group_id = ug.group_id
         JOIN iam.permissions p ON p.id = gp.permission_id WHERE ug.user_id = $1`,
      [U2.nochat],
    );
    expect(rows.map((x) => x.k)).toEqual(['assistant_escalation:register']);
    const before = await countEscalations();
    const r = await http('POST', '/api/admin/assistants/escalations', { person: U2.nochat, service: serviceAuth() }, { ...ESCALATION, janela_de: '2026-10-10', janela_ate: '2026-10-11' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('NO_REACH_TO_ASSISTANT');
    expect(await countEscalations()).toBe(before);
  });

  it('item 29c — no assistant prompt in the DB: count(ai_prompts WHERE slug LIKE ASSISTANT\\_%) = 0 (positive control: there is at least 1 prompt)', async () => {
    const assistant = await admin.query(`SELECT count(*)::int AS n FROM ai_prompts WHERE slug LIKE 'ASSISTANT\\_%'`);
    expect(assistant.rows[0].n).toBe(0);
    const existing = await admin.query(`SELECT count(*)::int AS n FROM ai_prompts WHERE slug LIKE 'VACANCY\\_%'`);
    expect(existing.rows[0].n).toBeGreaterThanOrEqual(1);
  });
});
