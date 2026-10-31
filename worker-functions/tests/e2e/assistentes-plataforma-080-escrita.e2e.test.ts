/**
 * assistentes-plataforma-080-escrita.e2e.test.ts — spec 080, fase A, T063 (parte 2): placar, reporte "Llevar al Sol" e a
 * ausência de prompt de gestora (itens 25 e 29c) contra POSTGRES REAL e HTTP real, ENGINE LIGADO, sync do catálogo LIGADO.
 * Contrato: `rotas-plataforma-novas.md` §2, §3, §6. Molde: `assistentes-plataforma-080.e2e.test.ts` (parte 1; os helpers
 * pequenos foram repetidos de propósito: extrair para um helper compartilhado não compensou o risco da memória jest-e-tsc).
 *
 * FIXTURE: as células Master-only não entram em grupo comum pelo app (422). O grupo "reporte sem chat" é montado por
 * INSERT direto no banco do stack (`grupoComCelulas`): só `agentes_reporte:registrar`, SEM `assistente_maria:chat`.
 * Dados 100% SINTÉTICOS (operador `qa080-*`, contas `qa.080w.*@enlite.test`), sem texto de conversa nem PII.
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
const PROJETO = 'plat080-e2e';
const SA = `gestoras-service-sa@${PROJETO}.iam.gserviceaccount.com`;
const AUDIENCIA = 'https://api.enlite.health/assistentes';
const RUN = Date.now().toString(36);

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64');
/** Identidade da PESSOA (mockAuthMiddleware): e-mail sintético `qa.080.*@enlite.test`, claim `country` obrigatório. */
const pessoa = (uid: string) =>
  `Bearer mock_${b64({ uid, email: `${uid.replace(/-/g, '.')}@enlite.test`, role: 'admin', country: 'AR' })}`;
/** Identidade do SERVIÇO: token de teste do VerificadorIdentidadeServico (só sob USE_MOCK_AUTH=true). */
const servico = (o: Partial<{ email: string; email_verified: boolean; aud: string }> = {}) =>
  `Bearer mock_${b64({ email: SA, email_verified: true, aud: AUDIENCIA, ...o })}`;

const OPERADOR = `qa080-${RUN}`.slice(0, 40);
const U2 = {
  master: 'qa-080w-master-' + RUN,
  semchat: 'qa-080w-semchat-' + RUN, // tem agentes_reporte:registrar, NÃO tem assistente_maria:chat
};
const GRUPO_SEMCHAT = `Qa080w SemChat ${RUN}`;

describe('assistentes da plataforma — placar, reporte e sem prompt de gestora — HTTP real, banco real (spec 080, T063)', () => {
  let admin: Pool;
  let app: AppComTodasFamilias;
  const envAnterior: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string): void => {
    if (!(k in envAnterior)) envAnterior[k] = process.env[k];
    process.env[k] = v;
  };

  async function http(method: string, path: string, h: { pessoa?: string | null; servico?: string | null }, body?: unknown) {
    const res = await fetch(`${app.url}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(h.pessoa ? { Authorization: pessoa(h.pessoa) } : {}),
        ...(h.servico ? { 'X-Enlite-Servico': h.servico } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
  }

  const PLACAR = () => {
    const agora = Date.now();
    const de = new Date(agora - 86400000).toISOString();
    const ate = new Date(agora + 86400000).toISOString();
    return `/api/admin/agentes/placar?operador=${OPERADOR}&de=${encodeURIComponent(de)}&ate=${encodeURIComponent(ate)}`;
  };
  const REPORTE = {
    gestora: 'maria',
    operador: OPERADOR,
    area: 'recrutamento',
    caso: 'leve',
    regra_ref: 'regra-sintetica',
    janela_de: '2026-10-01',
    janela_ate: '2026-10-07',
    observacao: 'observacao sintetica',
  };
  const contarReportes = async (): Promise<number> =>
    (await admin.query(`SELECT count(*)::int AS n FROM agentes.reportes WHERE operador = $1`, [OPERADOR])).rows[0].n;

  const limparAgentes = async () => {
    await admin.query(`DELETE FROM agentes.reporte_veredictos WHERE reporte_id IN (SELECT id FROM agentes.reportes WHERE operador = $1)`, [OPERADOR]);
    await admin.query(`DELETE FROM agentes.reportes WHERE operador = $1`, [OPERADOR]);
    await admin.query(`DELETE FROM agentes.veredicto_achados WHERE veredicto_id IN (SELECT id FROM agentes.veredictos WHERE operador = $1)`, [OPERADOR]);
    await admin.query(`DELETE FROM agentes.veredictos WHERE operador = $1`, [OPERADOR]);
  };
  const limparIam = () => limparIamFixtures(admin, { uids: Object.values(U2), grupos: [GRUPO_SEMCHAT] });

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });
    await limparAgentes();
    await limparIam();

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('GCP_PROJECT_ID', PROJETO);
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_CATALOG_SYNC_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.integrations');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);

    await admin.query(
      `INSERT INTO iam.rollout_state (key, value, note) VALUES ('permission_groups_migrated', 'done', 'e2e-assistentes-plataforma-080-escrita')
       ON CONFLICT (key) DO UPDATE SET value = 'done'`,
    );
    await admin.query(
      `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES
         ($1,'qa.080w.master@enlite.test','admin','ACTIVE',true,$3), ($2,'qa.080w.semchat@enlite.test','admin','ACTIVE',true,$3)`,
      [U2.master, U2.semchat, TENANT_E2E],
    );
    await admin.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [U2.master, MASTER_ID, TENANT_E2E]);

    const { createAdminAssistentesRoutes, createAssistentesPlataformaController } = await import('../../src/modules/agentes');
    const { ENLITE_TENANT_ID } = await import('@modules/identity/permissions');
    app = await montarAppComTodasFamilias({
      internalSecret: 'e2e-assistentes-plataforma-080-escrita-secret',
      montarRotas: ({ app: express, auth, permissions, modulo }) => {
        const resolverCelulas = async (uid: string) =>
          (await modulo.authz.execute({ uid, tenantId: ENLITE_TENANT_ID })).permissions;
        express.use('/api/admin', createAdminAssistentesRoutes(createAssistentesPlataformaController(resolverCelulas), auth, permissions));
      },
    });
    // FIXTURE por INSERT direto (o app recusa célula Master-only em grupo comum): só reporte, SEM assistente_maria:chat.
    // Roda DEPOIS do boot (o sync do catálogo cria as células).
    await grupoComCelulas(admin, { nome: GRUPO_SEMCHAT, uid: U2.semchat, celulas: [['agentes_reporte', 'registrar']] });

    // Veredicto sintético (sensor silente: sem nota, sem texto) + 1 achado de violação
    const v = await admin.query(
      `INSERT INTO agentes.veredictos (operador, sensor, inbox, conversa_ref, ultima_msg_ref, cruza_areas)
       VALUES ($1,'silente','inbox-sintetica','conv-sintetica','msg-sintetica',true) RETURNING id`,
      [OPERADOR],
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
    await limparAgentes();
    await limparIam();
    await admin.query(`DELETE FROM iam.rollout_state WHERE key = 'permission_groups_migrated'`);
    await admin.end();
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('placar com um veredicto semeado: devolve SÓ os campos do contrato §2 (sem ids, sem conversa_ref)', async () => {
    const r = await http('GET', PLACAR(), { pessoa: U2.master, servico: servico() });
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['ate', 'conversas', 'cruza_areas', 'de', 'nota_media', 'operador', 'por_regra', 'veredictos']);
    expect(r.body).toMatchObject({ operador: OPERADOR, veredictos: 1, conversas: 1, cruza_areas: 1, nota_media: null });
    expect(r.body.por_regra).toEqual([{ regra_ref: 'regra-sintetica', violacoes: 1, gravidade_max: 'media' }]);
    expect(JSON.stringify(r.body)).not.toMatch(/"(texto|trecho|resumo|nome|telefone|conversa_ref|uid|email|actor|changed_by|veredicto_ids|graves)"/);
  });

  it('reporte válido -> 201 e a tabela de reportes tem 1 linha', async () => {
    expect(await contarReportes()).toBe(0);
    const r = await http('POST', '/api/admin/agentes/reportes', { pessoa: U2.master, servico: servico() }, REPORTE);
    expect(r.status).toBe(201);
    expect(typeof r.body.id).toBe('string');
    expect(r.body.duplicado).toBeUndefined();
    expect(await contarReportes()).toBe(1);
    const linha = await admin.query(`SELECT autor, operador FROM agentes.reportes WHERE id = $1`, [r.body.id]);
    expect(linha.rows[0]).toEqual({ autor: 'maria', operador: OPERADOR });
  });

  it('o mesmo reporte de novo: 2ª vez devolve duplicado e a contagem fica 1', async () => {
    expect(await contarReportes()).toBe(1);
    const r = await http('POST', '/api/admin/agentes/reportes', { pessoa: U2.master, servico: servico() }, REPORTE);
    expect(r.status).toBe(200);
    expect(r.body.duplicado).toBe(true);
    expect(typeof r.body.id).toBe('string');
    expect(await contarReportes()).toBe(1);
  });

  it('observacao de 501 caracteres -> 400 e a contagem não muda (controle: 500 caracteres passa)', async () => {
    const antes = await contarReportes();
    const r = await http('POST', '/api/admin/agentes/reportes', { pessoa: U2.master, servico: servico() }, { ...REPORTE, janela_de: '2026-10-08', janela_ate: '2026-10-09', observacao: 'a'.repeat(501) });
    expect(r.status).toBe(400);
    expect(await contarReportes()).toBe(antes);
    // controle positivo: o MESMO corpo com 500 caracteres é aceito (o 400 acima é do tamanho)
    const ok = await http('POST', '/api/admin/agentes/reportes', { pessoa: U2.master, servico: servico() }, { ...REPORTE, janela_de: '2026-10-08', janela_ate: '2026-10-09', observacao: 'a'.repeat(500) });
    expect(ok.status).toBe(201);
    expect(await contarReportes()).toBe(antes + 1);
  });

  it('conta com agentes_reporte:registrar mas SEM assistente_maria:chat -> 403 e a contagem não muda', async () => {
    const { rows } = await admin.query(
      `SELECT p.resource || ':' || p.action AS k FROM iam.user_groups ug JOIN iam.group_permissions gp ON gp.group_id = ug.group_id
         JOIN iam.permissions p ON p.id = gp.permission_id WHERE ug.user_id = $1`,
      [U2.semchat],
    );
    expect(rows.map((x) => x.k)).toEqual(['agentes_reporte:registrar']);
    const antes = await contarReportes();
    const r = await http('POST', '/api/admin/agentes/reportes', { pessoa: U2.semchat, servico: servico() }, { ...REPORTE, janela_de: '2026-10-10', janela_ate: '2026-10-11' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('SEM_ALCANCE_A_GESTORA');
    expect(await contarReportes()).toBe(antes);
  });

  it('item 29c — nenhum prompt de gestora no banco: count(ai_prompts WHERE slug LIKE ASSISTENTE\\_%) = 0 (controle positivo: há ao menos 1 prompt)', async () => {
    const gestora = await admin.query(`SELECT count(*)::int AS n FROM ai_prompts WHERE slug LIKE 'ASSISTENTE\\_%'`);
    expect(gestora.rows[0].n).toBe(0);
    const existentes = await admin.query(`SELECT count(*)::int AS n FROM ai_prompts WHERE slug LIKE 'VACANCY\\_%'`);
    expect(existentes.rows[0].n).toBeGreaterThanOrEqual(1);
  });
});
