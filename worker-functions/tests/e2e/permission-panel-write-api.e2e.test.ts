import { Pool } from 'pg';
import {
  TENANT_E2E,
  tokenMock,
  montarAppDeFamilia,
  limparIamFixtures,
  grupoComCelulas,
  type AppDeFamilia,
} from './helpers/permissionFamilyHarness';

/**
 * O CAMINHO FELIZ das 9 rotas de escrita (F4) — banco real, HTTP real.
 *
 * A bateria de abuso (`permission-panel-write-abuse.e2e.test.ts`) prova que
 * ninguém não-autorizado escreve. Este arquivo prova o outro lado: que quem É
 * autorizado consegue, e que o EFEITO chega ao banco. Sem ele, uma função
 * `SECURITY DEFINER` que recusasse tudo passaria naquela bateria inteira.
 *
 * ⚠️ Cada caso afirma a LINHA no banco, não o status HTTP. 200 com nada gravado
 * é o modo de falha que este arquivo existe para pegar.
 *
 * Fixtures próprias, prefixo próprio — nada compartilhado com a bateria de
 * abuso, para que ordem de execução entre suítes não acople uma na outra.
 */

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('escrita do painel — caminho feliz, efeito no banco (F4)', () => {
  let pool: Pool;
  let app: AppDeFamilia;

  const GESTOR = 'write-e2e-gestor';
  const MEMBRO = 'write-e2e-membro';
  const G_GESTAO = 'Write E2E Gestão';
  const G_TRABALHO = 'Write E2E Trabalho';
  const FEATURE = 'screen:write-e2e';
  let idGestao: string;
  let idTrabalho: string;

  const envAnterior: Record<string, string | undefined> = {};
  function setEnv(chave: string, valor: string): void {
    envAnterior[chave] = process.env[chave];
    process.env[chave] = valor;
  }

  async function chamar(metodo: string, caminho: string, corpo?: unknown, uid = GESTOR) {
    const res = await fetch(`${app.url}${caminho}`, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', Authorization: tokenMock(uid) },
      ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  /**
   * ⚠️ A ordem aqui é contrato, e eu errei nela: os grupos saem por PREFIXO e
   * ANTES de `limparIamFixtures`, que apaga os users.
   *
   * O que quebrava: o helper apaga os grupos pela lista EXATA de nomes e só
   * então os users. Um grupo criado pelo teste com nome fora da lista (o
   * `Write E2E Para Arquivar`, do último caso) sobrevivia com
   * `archived_by = GESTOR`, e o `DELETE FROM users` batia na FK
   * `permission_groups_archived_by_fkey`. A suíte reportava `Tests: 9 passed` e
   * `Test Suites: 1 failed` — verde por dentro, vermelha por fora, e a rodada
   * seguinte já explodia no `beforeAll` por resíduo.
   *
   * Lista de nomes é régua de FORMA: quebra assim que um caso cria um grupo a
   * mais. O prefixo cobre a classe. Os dependentes saem junto, na ordem das FKs.
   */
  async function limpar(): Promise<void> {
    await pool.query(`DELETE FROM iam.country_feature_changes WHERE feature_key = $1`, [FEATURE]);
    await pool.query(`DELETE FROM iam.country_features WHERE feature_key = $1`, [FEATURE]);

    const doTeste = `(SELECT id FROM iam.permission_groups WHERE name LIKE 'Write E2E%')`;
    await pool.query(`DELETE FROM iam.permission_audit_log WHERE user_id = ANY($1)`, [[GESTOR, MEMBRO]]);
    await pool.query(`DELETE FROM iam.permission_group_changes WHERE group_id IN ${doTeste}`);
    await pool.query(`DELETE FROM iam.group_country_scopes WHERE group_id IN ${doTeste}`);
    await pool.query(`DELETE FROM iam.group_permissions WHERE group_id IN ${doTeste}`);
    await pool.query(`DELETE FROM iam.user_groups WHERE group_id IN ${doTeste}`);
    await pool.query(`DELETE FROM iam.permission_groups WHERE name LIKE 'Write E2E%'`);

    await limparIamFixtures(pool, { uids: [GESTOR, MEMBRO], grupos: [] });
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();
    await pool.query(
      `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES
         ($1, 'write-gestor@e2e.local', 'admin', 'ACTIVE', true, $3),
         ($2, 'write-membro@e2e.local', 'admin', 'ACTIVE', true, $3)`,
      [GESTOR, MEMBRO, TENANT_E2E],
    );
    idGestao = await grupoComCelulas(pool, {
      nome: G_GESTAO, uid: GESTOR,
      celulas: [['permission_management', 'write'], ['permission_management', 'read']],
    });
    idTrabalho = await grupoComCelulas(pool, { nome: G_TRABALHO, uid: MEMBRO, celulas: [['worker', 'read']] });

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'false');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);

    const { createPermissionPanelWriteRoutes } = await import('@modules/identity');
    app = await montarAppDeFamilia({
      montarRotas: ({ app: ex, auth, permissions, modulo }) => {
        ex.use('/api/admin', createPermissionPanelWriteRoutes({ writer: modulo, auth, permissions, tenantId: TENANT_E2E }));
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

  it('POST cria o grupo, e ele existe no banco com o criador registrado', async () => {
    const res = await chamar('POST', '/api/admin/permission-groups', { name: 'Write E2E Novo', description: 'criado no e2e' });

    expect(res.status).toBe(200);
    const r = await pool.query(`SELECT name, description, created_by, is_system FROM iam.permission_groups WHERE id = $1`, [res.body.groupId]);
    expect(r.rows[0]).toMatchObject({
      name: 'Write E2E Novo', description: 'criado no e2e', created_by: GESTOR, is_system: false,
    });
  });

  it('PATCH renomeia, e o banco tem o nome novo', async () => {
    const criado = await chamar('POST', '/api/admin/permission-groups', { name: 'Write E2E Renomeado' });

    const res = await chamar('PATCH', `/api/admin/permission-groups/${criado.body.groupId}`, { description: 'descrição nova' });

    expect(res.status).toBe(200);
    const r = await pool.query(`SELECT description FROM iam.permission_groups WHERE id = $1`, [criado.body.groupId]);
    expect(r.rows[0].description).toBe('descrição nova');
  });

  it('PUT /permissions substitui o conjunto INTEIRO — o que não veio, sai', async () => {
    await chamar('PUT', `/api/admin/permission-groups/${idTrabalho}/permissions`, {
      cellKeys: ['funnel:read', 'vacancy:read'], reason: 'troca de escopo',
    });

    const r = await pool.query(
      `SELECT p.resource || ':' || p.action AS k FROM iam.group_permissions gp
         JOIN iam.permissions p ON p.id = gp.permission_id WHERE gp.group_id = $1 ORDER BY 1`,
      [idTrabalho],
    );
    expect(r.rows.map((x) => x.k)).toEqual(['funnel:read', 'vacancy:read']);
    // `worker:read`, que estava lá, SAIU — é o ponto do PUT.
    expect(r.rows.map((x) => x.k)).not.toContain('worker:read');
  });

  it('POST /countries concede, e o MOTIVO fica na trilha do grupo', async () => {
    const res = await chamar('POST', `/api/admin/permission-groups/${idTrabalho}/countries`, {
      country: 'BR', reason: 'expansão piloto',
    });

    expect(res.status).toBe(200);
    const r = await pool.query(
      `SELECT country, reason, revoked_at FROM iam.group_country_scopes WHERE group_id = $1 AND country = 'BR'`,
      [idTrabalho],
    );
    expect(r.rows[0]).toMatchObject({ country: 'BR', reason: 'expansão piloto', revoked_at: null });
  });

  it('DELETE /countries REVOGA sem apagar — a concessão e a revogação ficam as duas', async () => {
    const res = await chamar('DELETE', `/api/admin/permission-groups/${idTrabalho}/countries/BR`);

    expect(res.status).toBe(200);
    const r = await pool.query(
      `SELECT revoked_at FROM iam.group_country_scopes WHERE group_id = $1 AND country = 'BR'`,
      [idTrabalho],
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].revoked_at).not.toBeNull();
  });

  it('POST /members adiciona, e o vínculo fica vivo com quem concedeu', async () => {
    const res = await chamar('POST', `/api/admin/permission-groups/${idTrabalho}/members`, { userId: GESTOR });

    expect(res.status).toBe(200);
    const r = await pool.query(
      `SELECT assigned_by, removed_at FROM iam.user_groups WHERE group_id = $1 AND user_id = $2 AND removed_at IS NULL`,
      [idTrabalho, GESTOR],
    );
    expect(r.rows[0]).toMatchObject({ assigned_by: GESTOR, removed_at: null });
  });

  it('DELETE /members remove marcando `removed_at` — a linha não é apagada', async () => {
    const res = await chamar('DELETE', `/api/admin/permission-groups/${idTrabalho}/members/${GESTOR}`);

    expect(res.status).toBe(200);
    const r = await pool.query(
      `SELECT removed_at, removed_by FROM iam.user_groups WHERE group_id = $1 AND user_id = $2`,
      [idTrabalho, GESTOR],
    );
    expect(r.rows[0].removed_at).not.toBeNull();
    expect(r.rows[0].removed_by).toBe(GESTOR);
  });

  it('PUT /country-features grava o override e a mudança anterior na trilha', async () => {
    const res = await chamar('PUT', `/api/admin/country-features/AR/${FEATURE}`, {
      enabled: true, config: null, reason: 'ligando no piloto',
    });

    expect(res.status).toBe(200);
    const f = await pool.query(`SELECT enabled, source, reason, updated_by FROM iam.country_features WHERE country='AR' AND feature_key=$1`, [FEATURE]);
    expect(f.rows[0]).toMatchObject({ enabled: true, source: 'override', reason: 'ligando no piloto', updated_by: GESTOR });

    const t = await pool.query(`SELECT new_enabled, changed_by FROM iam.country_feature_changes WHERE feature_key=$1`, [FEATURE]);
    expect(t.rows[0]).toMatchObject({ new_enabled: true, changed_by: GESTOR });
  });

  it('DELETE /permission-groups ARQUIVA — o grupo some da lista viva mas a linha fica', async () => {
    const criado = await chamar('POST', '/api/admin/permission-groups', { name: 'Write E2E Para Arquivar' });

    const res = await chamar('DELETE', `/api/admin/permission-groups/${criado.body.groupId}`);

    expect(res.status).toBe(200);
    const r = await pool.query(`SELECT archived_at FROM iam.permission_groups WHERE id = $1`, [criado.body.groupId]);
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].archived_at).not.toBeNull();
  });
});
