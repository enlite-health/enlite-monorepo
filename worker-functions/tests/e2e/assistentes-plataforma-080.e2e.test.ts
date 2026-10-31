/**
 * assistentes-plataforma-080.e2e.test.ts — spec 080, fase A, T061 (parte 1): as DUAS identidades, o alcance e a 1ª chave
 * (itens 7 e 9) contra POSTGRES REAL e HTTP real, com o ENGINE DE PERMISSÃO LIGADO (`admin.integrations`) e o sync do
 * catálogo LIGADO. Contrato: `rotas-plataforma-novas.md` §0, §1, §5.
 *
 * Prova: (1) as 12 células novas entram no catálogo SEM migration e só o Acesso Master as tem; (2) o Master vê as 3
 * gestoras e as 7 gavetas no alcance, quem não tem `assistente_maria:chat` não vê `maria`; (3) só serviço, só pessoa ou as
 * duas -> 401/401/200; (4) sem a célula -> 403 no placar e no reporte (a 1ª chave é da plataforma); (5) célula Master-only
 * não entra em grupo comum (422) e a conta continua 403.
 * Identidade do serviço: token de teste `mock_<base64>` aceito SÓ sob USE_MOCK_AUTH=true (VerificadorIdentidadeServico).
 * Dados 100% SINTÉTICOS (`qa.080.*@enlite.test`); a limpeza usa a conexão de admin. Sem rede ao Google/Vertex/KMS.
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
const PROJETO = 'plat080-e2e';
const SA = `gestoras-service-sa@${PROJETO}.iam.gserviceaccount.com`;
const AUDIENCIA = 'https://api.enlite.health/assistentes';
const RUN = Date.now().toString(36);

const CELULAS_NOVAS: Array<[string, string]> = [
  ['assistente_maria', 'chat'],
  ['assistente_lucero', 'chat'],
  ['assistente_candela', 'chat'],
  ['agentes_placar', 'read'],
  ['agentes_reporte', 'registrar'],
  ...['publico', 'recrutamento', 'clinico', 'financeiro', 'gestao', 'coordenacao', 'tecnico'].map(
    (g) => [`conhecimento_${g}`, 'read'] as [string, string],
  ),
];
const GAVETAS = ['publico', 'recrutamento', 'clinico', 'financeiro', 'gestao', 'coordenacao', 'tecnico'];

const U = {
  master: 'qa-080-master-' + RUN,
  comum: 'qa-080-comum-' + RUN, // staff com UMA célula qualquer (dashboard:read), sem nenhuma célula nova
};
const GRUPO_COMUM = `Qa080 Comum ${RUN}`;

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64');
/** Identidade da PESSOA (mockAuthMiddleware): e-mail sintético `qa.080.*@enlite.test`, claim `country` obrigatório. */
const pessoa = (uid: string) =>
  `Bearer mock_${b64({ uid, email: `${uid.replace(/-/g, '.')}@enlite.test`, role: 'admin', country: 'AR' })}`;
/** Identidade do SERVIÇO: token de teste do VerificadorIdentidadeServico (só sob USE_MOCK_AUTH=true). */
const servico = (o: Partial<{ email: string; email_verified: boolean; aud: string }> = {}) =>
  `Bearer mock_${b64({ email: SA, email_verified: true, aud: AUDIENCIA, ...o })}`;

describe('assistentes da plataforma — duas identidades, alcance e 1ª chave — HTTP real, banco real, engine LIGADO (spec 080, T061)', () => {
  let admin: Pool;
  let app: AppComTodasFamilias;
  let grupoComumId: string;
  const envAnterior: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string): void => {
    if (!(k in envAnterior)) envAnterior[k] = process.env[k];
    process.env[k] = v;
  };

  async function http(
    method: string,
    path: string,
    h: { pessoa?: string | null; servico?: string | null },
    body?: unknown,
  ) {
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
    const ate = new Date();
    const de = new Date(ate.getTime() - 7 * 86400000);
    return `/api/admin/agentes/placar?operador=luz&de=${encodeURIComponent(de.toISOString())}&ate=${encodeURIComponent(ate.toISOString())}`;
  };
  const REPORTE = {
    gestora: 'maria',
    operador: 'luz',
    area: 'recrutamento',
    caso: 'leve',
    regra_ref: 'regra-sintetica',
    janela_de: '2026-10-01',
    janela_ate: '2026-10-07',
    observacao: 'observacao sintetica',
  };

  const limparIam = () => limparIamFixtures(admin, { uids: Object.values(U), grupos: [GRUPO_COMUM] });
  const celulasDe = async (groupId: string) =>
    (
      await admin.query(
        `SELECT p.resource || ':' || p.action AS k FROM iam.group_permissions gp JOIN iam.permissions p ON p.id = gp.permission_id
          WHERE gp.group_id = $1 ORDER BY 1`,
        [groupId],
      )
    ).rows.map((r) => r.k as string);

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });
    await limparIam();

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('GCP_PROJECT_ID', PROJETO);
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_CATALOG_SYNC_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.integrations');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);

    // Marcador do rollout — sem ele `runPermissionsBootTasks` recusa o boot com o engine ligado.
    await admin.query(
      `INSERT INTO iam.rollout_state (key, value, note) VALUES ('permission_groups_migrated', 'done', 'e2e-assistentes-plataforma-080')
       ON CONFLICT (key) DO UPDATE SET value = 'done'`,
    );

    await admin.query(
      `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES
         ($1,'qa.080.master@enlite.test','admin','ACTIVE',true,$3), ($2,'qa.080.comum@enlite.test','admin','ACTIVE',true,$3)`,
      [U.master, U.comum, TENANT_E2E],
    );
    await admin.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [U.master, MASTER_ID, TENANT_E2E]);
    grupoComumId = await grupoComCelulas(admin, { nome: GRUPO_COMUM, uid: U.comum, celulas: [['dashboard', 'read']] });
    // SABOTAGEM-ANCORA

    const { createAdminAssistentesRoutes, createAssistentesPlataformaController } = await import('../../src/modules/agentes');
    const { ENLITE_TENANT_ID } = await import('@modules/identity/permissions');
    app = await montarAppComTodasFamilias({
      internalSecret: 'e2e-assistentes-plataforma-080-secret',
      montarRotas: ({ app: express, auth, permissions, modulo }) => {
        const resolverCelulas = async (uid: string) =>
          (await modulo.authz.execute({ uid, tenantId: ENLITE_TENANT_ID })).permissions;
        express.use('/api/admin', createAdminAssistentesRoutes(createAssistentesPlataformaController(resolverCelulas), auth, permissions));
      },
    });
  }, 60000);

  afterAll(async () => {
    await app?.fechar();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await limparIam();
    await admin.query(`DELETE FROM iam.rollout_state WHERE key = 'permission_groups_migrated'`);
    await admin.end();
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('as 12 células novas existem no catálogo do banco SEM migration (sync do boot) e SÓ o Acesso Master as tem', async () => {
    const chaves = CELULAS_NOVAS.map(([r, a]) => `${r}:${a}`);
    expect(chaves).toHaveLength(12);
    const cat = await admin.query(
      `SELECT count(*)::int AS n FROM iam.permissions WHERE resource || ':' || action = ANY($1) AND deprecated_at IS NULL`,
      [chaves],
    );
    expect(cat.rows[0].n).toBe(12);
    expect((await celulasDe(MASTER_ID)).filter((k) => chaves.includes(k))).toEqual([...chaves].sort());
    const outros = await admin.query(
      `SELECT g.name FROM iam.group_permissions gp JOIN iam.permissions p ON p.id = gp.permission_id JOIN iam.permission_groups g ON g.id = gp.group_id
        WHERE p.resource || ':' || p.action = ANY($1) AND g.id <> $2`,
      [chaves, MASTER_ID],
    );
    expect(outros.rows).toEqual([]);
    // nenhuma migration mexe nelas: o sync é o único caminho
    const dir = join(__dirname, '../../migrations');
    const tocam = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .filter((f) => {
        const sql = readFileSync(join(dir, f), 'utf8');
        return /INSERT\s+INTO\s+iam\.permissions/i.test(sql) && /assistente_(maria|lucero|candela)|agentes_placar|agentes_reporte|conhecimento_(publico|recrutamento|clinico)/.test(sql);
      });
    expect(tocam).toEqual([]);
    expect(readdirSync(dir).filter((f) => f.endsWith(".sql")).some((f) => /INSERT\s+INTO\s+iam\.permissions/i.test(readFileSync(join(dir, f), "utf8")))).toBe(true); // controle positivo: o filtro enxerga migration que insere célula
  });

  it('conta do Acesso Master: o alcance devolve as 3 gestoras e as 7 gavetas, na ordem das constantes', async () => {
    const r = await http('GET', '/api/admin/assistentes/alcance', { pessoa: U.master, servico: servico() });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ uid: U.master, gestoras: ['maria', 'lucero', 'candela'], conhecimento: GAVETAS });
  });

  it('conta SEM assistente_maria:chat: o alcance não traz maria (nem nenhuma gestora, nem gaveta)', async () => {
    expect(await celulasDe(grupoComumId)).not.toContain('assistente_maria:chat');
    const r = await http('GET', '/api/admin/assistentes/alcance', { pessoa: U.comum, servico: servico() });
    expect(r.status).toBe(200);
    expect(r.body.gestoras).not.toContain('maria');
    expect(r.body).toEqual({ uid: U.comum, gestoras: [], conhecimento: [] });
  });

  it('item 9 — duas identidades: só o serviço -> 401; só a pessoa -> 401; as duas -> 200', async () => {
    const soServico = await http('GET', '/api/admin/assistentes/alcance', { servico: servico() });
    expect(soServico.status).toBe(401);
    const soPessoa = await http('GET', '/api/admin/assistentes/alcance', { pessoa: U.master });
    expect(soPessoa.status).toBe(401);
    expect(soPessoa.body.error).toBe('SERVICO_NAO_AUTENTICADO');
    const duas = await http('GET', '/api/admin/assistentes/alcance', { pessoa: U.master, servico: servico() });
    expect(duas.status).toBe(200);
    // placar: a mesma regra (a pessoa Master sozinha também é barrada)
    expect((await http('GET', PLACAR(), { pessoa: U.master })).status).toBe(401);
    expect((await http('GET', PLACAR(), { pessoa: U.master, servico: servico() })).status).toBe(200);
  });

  it('identidade do serviço inválida (outra audiência, e-mail não verificado, e-mail fora da allowlist) -> 401 mesmo com a pessoa certa', async () => {
    for (const ruim of [
      servico({ aud: 'https://outra.audiencia' }),
      servico({ email_verified: false }),
      servico({ email: 'outra-sa@outro-projeto.iam.gserviceaccount.com' }),
    ]) {
      const r = await http('GET', '/api/admin/assistentes/alcance', { pessoa: U.master, servico: ruim });
      expect(r.status).toBe(401);
      expect(r.body.error).toBe('SERVICO_NAO_AUTENTICADO');
    }
  });

  it('item 7 — a 1ª chave é da plataforma: sem a célula -> 403 no placar e no reporte (as duas identidades válidas)', async () => {
    const placar = await http('GET', PLACAR(), { pessoa: U.comum, servico: servico() });
    expect(placar.status).toBe(403);
    const reporte = await http('POST', '/api/admin/agentes/reportes', { pessoa: U.comum, servico: servico() }, REPORTE);
    expect(reporte.status).toBe(403);
    // controle: com a célula (Master) o MESMO pedido não é 403 — o 403 acima é da célula, não de outra coisa
    expect((await http('GET', PLACAR(), { pessoa: U.master, servico: servico() })).status).toBe(200);
  });

  it('não-Master -> 403/422: dar agentes_placar:read a grupo comum é recusado (422 master_only_cell, 0 linhas) e a conta continua 403', async () => {
    const antes = await celulasDe(grupoComumId);
    await expect(
      app.modulo.groups.setPermissions.execute({
        tenantId: TENANT_E2E,
        groupId: grupoComumId,
        cellKeys: ['dashboard:read', 'agentes_placar:read'],
      }),
    ).rejects.toMatchObject({ code: 'master_only_cell' });
    const depois = await celulasDe(grupoComumId);
    expect(depois).toEqual(antes);
    expect(depois).not.toContain('agentes_placar:read');
    const r = await http('GET', PLACAR(), { pessoa: U.comum, servico: servico() });
    expect(r.status).toBe(403);
  });
});
