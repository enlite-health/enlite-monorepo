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
 * A API de LEITURA do painel — HTTP real, banco real (F3, task 4.1 leitura).
 *
 * Duas rotas com estatutos OPOSTOS, e é o contraste que este arquivo existe
 * para provar:
 *
 *  · `GET /api/admin/permissions/catalog` — decisão de staff. Exige
 *    `permission_management:read`; sem a célula, 403.
 *  · `GET /v1/me/authz` — *self*. Responde 200 até para quem NÃO TEM NENHUM
 *    GRUPO, porque é justamente o contrato que a tela de boas-vindas lê. Se
 *    alguém "consertar" isso pondo uma célula na rota, o painel some para todo
 *    staff novo e o caso `semGrupo` aqui fica vermelho.
 *
 * ⚠️ Mock do jest é PROIBIDO neste arquivo: nada é substituído: as duas rotas
 * consomem os use cases de produção contra o Postgres de verdade.
 *
 * ⚠️ As envs de flag são escritas ANTES do primeiro import de `src/`, por isso
 * todo o `src/` entra por `await import()` dentro do `beforeAll`.
 */

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('API de leitura do painel de acessos (HTTP real, banco real)', () => {
  let pool: Pool;
  let app: AppDeFamilia;
  const U = {
    /** Tem `permission_management:read` — quem opera o painel. */
    gestora: 'panel-e2e-gestora',
    /** Staff ativo, em grupo SEM a célula do painel. */
    semCelula: 'panel-e2e-sem-celula',
    /** Staff ativo e sem NENHUM grupo — o caso da tela de boas-vindas. */
    semGrupo: 'panel-e2e-sem-grupo',
  };
  const GRUPO_GESTAO = 'Panel E2E Gestão de Acessos';
  const GRUPO_SEM_CELULA = 'Panel E2E Sem Células';
  let grupoGestaoId: string;
  /**
   * ⚠️ `iam.country_features` nasce VAZIA no banco de e2e (medido: 0 linhas) —
   * quem a preenche é o sync do manifest no boot, que não roda aqui. Sem esta
   * semeadura, "devolve a matriz" e "filtra por país" passariam sobre conjunto
   * vazio: `every` de array vazio é `true`, e o teste ficaria verde provando
   * nada. Duas linhas, dois países, para o filtro ter o que excluir.
   */
  const FEATURE_E2E = 'screen:panel-e2e';

  const envAnterior: Record<string, string | undefined> = {};
  function setEnv(chave: string, valor: string): void {
    envAnterior[chave] = process.env[chave];
    process.env[chave] = valor;
  }

  async function chamar(
    caminho: string,
    uid: string | null,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${app.url}${caminho}`, {
      headers: uid ? { Authorization: tokenMock(uid) } : {},
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  /** POST — só a `/permission-audit/query`, que é a única rota de leitura que aceita corpo (C6). */
  async function chamarPost(
    caminho: string,
    uid: string | null,
    corpo: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${app.url}${caminho}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(uid ? { Authorization: tokenMock(uid) } : {}),
      },
      body: JSON.stringify(corpo),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  async function limpar(): Promise<void> {
    await pool.query(`DELETE FROM iam.country_features WHERE feature_key = $1`, [FEATURE_E2E]);
    await limparIamFixtures(pool, { uids: Object.values(U), grupos: [GRUPO_GESTAO, GRUPO_SEM_CELULA] });
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();

    await pool.query(
      `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES
         ($1, 'panel-gestora@e2e.local',  'admin', 'ACTIVE', true, $4),
         ($2, 'panel-semcel@e2e.local',   'admin', 'ACTIVE', true, $4),
         ($3, 'panel-semgrupo@e2e.local', 'admin', 'ACTIVE', true, $4)`,
      [U.gestora, U.semCelula, U.semGrupo, TENANT_E2E],
    );

    // `grupoComCelulas` explode se a célula não existir em `iam.permissions` —
    // é o controle positivo de que `permission_management:read` está no seed.
    grupoGestaoId = await grupoComCelulas(pool, {
      nome: GRUPO_GESTAO,
      uid: U.gestora,
      celulas: [['permission_management', 'read']],
    });
    await grupoComCelulas(pool, {
      nome: GRUPO_SEM_CELULA,
      uid: U.semCelula,
      celulas: [['vacancy', 'read']],
    });

    await pool.query(
      `INSERT INTO iam.country_features (country, feature_key, enabled, source, updated_by) VALUES
         ('AR', $1, true,  'default',  'e2e'),
         ('BR', $1, false, 'override', 'e2e')`,
      [FEATURE_E2E],
    );

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.permissions');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);

    const { createPermissionPanelRoutes, principalUid } = await import('@modules/identity');
    const { createMeAuthzRouter } = await import('@modules/identity/permissions');

    app = await montarAppDeFamilia({
      enforcedRoutes: 'admin.permissions',
      montarRotas: ({ app: express, auth, permissions, modulo }) => {
        express.use('/api/admin', createPermissionPanelRoutes({
          catalog: modulo.catalog.list,
          groups: modulo.repositories.groups,
          features: modulo.repositories.features,
          audit: modulo.audit,
          auth,
          permissions,
          tenantId: TENANT_E2E,
        }));
        express.use(
          '/v1',
          createMeAuthzRouter({
            getMyAuthz: modulo.authz,
            staffGuard: auth.requireStaff(),
            uidOf: principalUid,
            tenantId: TENANT_E2E,
          }),
        );
      },
    });
  }, 30000);

  afterAll(async () => {
    await app?.fechar();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await limpar();
    await pool.end();
    for (const [chave, valor] of Object.entries(envAnterior)) {
      if (valor === undefined) delete process.env[chave];
      else process.env[chave] = valor;
    }
  });

  describe('GET /api/admin/permissions/catalog — decisão de staff', () => {
    it('quem tem `permission_management:read` recebe o catálogo do banco', async () => {
      const res = await chamar('/api/admin/permissions/catalog', U.gestora);

      expect(res.status).toBe(200);
      const categorias = res.body.categories as Array<{ category: string; cells: unknown[] }>;
      expect(categorias.length).toBeGreaterThan(0);
      expect(categorias.every((c) => Array.isArray(c.cells) && c.cells.length > 0)).toBe(true);
    });

    it('🔴 a célula que a rota exige EXISTE no catálogo que ela devolve', async () => {
      const res = await chamar('/api/admin/permissions/catalog', U.gestora);

      const celulas = (res.body.categories as Array<{ cells: Array<{ resource: string; action: string }> }>)
        .flatMap((c) => c.cells)
        .map((c) => `${c.resource}:${c.action}`);

      // Se o sync descontinuar `permission_management:read`, ela some daqui
      // (a listagem filtra `deprecated_at`) — e este caso fica vermelho ANTES
      // de `iam.query_audit` começar a responder 42501 para todo mundo.
      expect(celulas).toContain('permission_management:read');
    });

    it('staff SEM a célula → 403, e o catálogo não sai', async () => {
      const res = await chamar('/api/admin/permissions/catalog', U.semCelula);

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'missing_cell' });
      expect(res.body.categories).toBeUndefined();
    });

    it('staff sem NENHUM grupo → 403 no_group', async () => {
      const res = await chamar('/api/admin/permissions/catalog', U.semGrupo);

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'no_group' });
    });

    it('sem credencial → 401 antes de qualquer decisão de permissão', async () => {
      expect((await chamar('/api/admin/permissions/catalog', null)).status).toBe(401);
    });

    it('query fora do contrato → 400 (zod na borda), não uma leitura silenciosa', async () => {
      const res = await chamar('/api/admin/permissions/catalog?includeDeprecated=talvez', U.gestora);

      expect(res.status).toBe(400);
    });
  });

  describe('GET /v1/me/authz — self', () => {
    it('devolve o contrato do ator, resolvido pelo BANCO', async () => {
      const res = await chamar('/v1/me/authz', U.gestora);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ uid: U.gestora, tenantId: TENANT_E2E, status: 'ACTIVE' });
      expect(res.body.permissions).toContain('permission_management:read');
      expect((res.body.groups as Array<{ name: string }>).map((g) => g.name)).toEqual([GRUPO_GESTAO]);
    });

    it('🔴 staff SEM GRUPO recebe 200 com contrato vazio — é a tela de boas-vindas, não um 403', async () => {
      const res = await chamar('/v1/me/authz', U.semGrupo);

      expect(res.status).toBe(200);
      expect(res.body.groups).toEqual([]);
      expect(res.body.permissions).toEqual([]);
      expect(res.body.status).toBe('ACTIVE');
    });

    it('staff sem a célula do painel também lê o PRÓPRIO contrato', async () => {
      const res = await chamar('/v1/me/authz', U.semCelula);

      expect(res.status).toBe(200);
      expect(res.body.permissions).toEqual(['vacancy:read']);
    });

    it('🔴 não existe como pedir o contrato de OUTRA pessoa — o sujeito é o principal', async () => {
      const res = await chamar(`/v1/me/authz?uid=${U.gestora}`, U.semCelula);

      expect(res.status).toBe(200);
      expect(res.body.uid).toBe(U.semCelula);
      expect(res.body.permissions).not.toContain('permission_management:read');
    });

    it('sem credencial → 401', async () => {
      expect((await chamar('/v1/me/authz', null)).status).toBe(401);
    });
  });

  describe('GET /api/admin/permission-groups — os grupos e os dois eixos', () => {
    it('lista os grupos do tenant, com células, países e contagem de membros', async () => {
      const res = await chamar('/api/admin/permission-groups', U.gestora);

      expect(res.status).toBe(200);
      const grupos = res.body.groups as Array<{ id: string; name: string; cells: string[]; memberCount: number }>;
      const gestao = grupos.find((g) => g.id === grupoGestaoId);
      expect(gestao).toMatchObject({ name: GRUPO_GESTAO, memberCount: 1 });
      expect(gestao?.cells).toEqual(['permission_management:read']);
    });

    it('staff SEM a célula → 403, e a lista não sai', async () => {
      const res = await chamar('/api/admin/permission-groups', U.semCelula);

      expect(res.status).toBe(403);
      expect(res.body.groups).toBeUndefined();
    });

    it('o detalhe traz o grupo resolvido', async () => {
      const res = await chamar(`/api/admin/permission-groups/${grupoGestaoId}`, U.gestora);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: grupoGestaoId, name: GRUPO_GESTAO, isSystem: false });
    });

    it('🔴 id que não existe neste tenant → 404, nunca 200 vazio', async () => {
      // Aqui o id é inexistente; o caso "existe em OUTRO tenant" é o mesmo
      // caminho de código — a porta devolve `null` nos dois, de propósito
      // (404 indistinguível de inexistente), e o unit cobre o contrato.
      const res = await chamar('/api/admin/permission-groups/99999999-9999-4999-8999-999999999999', U.gestora);

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ success: false, error: 'Not found' });
    });

    it('id malformado → 400, não 500 no cast do Postgres', async () => {
      expect((await chamar('/api/admin/permission-groups/nao-e-uuid', U.gestora)).status).toBe(400);
    });

    it('os membros do grupo saem com e-mail, papel e status', async () => {
      const res = await chamar(`/api/admin/permission-groups/${grupoGestaoId}/members`, U.gestora);

      expect(res.status).toBe(200);
      expect(res.body.members).toEqual([
        expect.objectContaining({
          userId: U.gestora,
          email: 'panel-gestora@e2e.local',
          status: 'ACTIVE',
        }),
      ]);
    });

    it('🔴 membros de grupo inexistente → 404, NÃO `{members: []}` com 200', async () => {
      const res = await chamar('/api/admin/permission-groups/99999999-9999-4999-8999-999999999999/members', U.gestora);

      expect(res.status).toBe(404);
      expect(res.body.members).toBeUndefined();
    });
  });

  describe('GET /api/admin/country-features — disponibilidade por país', () => {
    it('devolve a matriz país × feature — a MESMA chave nos dois países', async () => {
      const res = await chamar('/api/admin/country-features', U.gestora);

      expect(res.status).toBe(200);
      const minhas = (res.body.features as Array<{ country: string; featureKey: string; enabled: boolean; source: string }>)
        .filter((f) => f.featureKey === FEATURE_E2E);

      expect(minhas).toEqual([
        expect.objectContaining({ country: 'AR', enabled: true, source: 'default' }),
        expect.objectContaining({ country: 'BR', enabled: false, source: 'override' }),
      ]);
    });

    it('filtra por país — e o outro país SOME, que é o que prova o filtro', async () => {
      const res = await chamar('/api/admin/country-features?country=AR', U.gestora);

      expect(res.status).toBe(200);
      const features = res.body.features as Array<{ country: string; featureKey: string }>;
      // Não-vazio primeiro: `every` de lista vazia é `true` e aprovaria o filtro quebrado.
      expect(features.length).toBeGreaterThan(0);
      expect(features.every((f) => f.country === 'AR')).toBe(true);
      expect(features.some((f) => f.featureKey === FEATURE_E2E)).toBe(true);
      expect(features.some((f) => f.country === 'BR')).toBe(false);
    });

    it('país fora do catálogo → 400, não lista vazia silenciosa', async () => {
      expect((await chamar('/api/admin/country-features?country=XX', U.gestora)).status).toBe(400);
    });

    it('staff SEM a célula → 403', async () => {
      expect((await chamar('/api/admin/country-features', U.semCelula)).status).toBe(403);
    });
  });

  describe('GET /api/admin/permission-audit — a trilha', () => {
    it('🔴 o gestor lê a trilha por `iam.query_audit` — a função que o #245 quase matou', async () => {
      // Este caso é o motivo de a F3 vir antes da F5. Se
      // `permission_management:read` estiver descontinuada, a função levanta
      // 42501 e isto vira 500 — inclusive para o Acesso Master.
      const res = await chamar('/api/admin/permission-audit?limit=10', U.gestora);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.entries)).toBe(true);
    });

    it('a negativa que acabou de acontecer aparece na trilha, filtrada por `userId` no CORPO do POST', async () => {
      await chamar('/api/admin/permission-groups', U.semCelula);
      // A trilha é assíncrona fail-safe (nunca segura a request) — daí a espera.
      await new Promise((r) => setTimeout(r, 400));

      // `userId` saiu da query (C6, uid não pode cair no log de request do
      // Cloud Run) — o filtro por pessoa agora só existe no corpo do POST.
      const res = await chamarPost('/api/admin/permission-audit/query', U.gestora, {
        userId: U.semCelula,
        limit: 50,
      });

      expect(res.status).toBe(200);
      const linhas = res.body.entries as Array<{ userId: string; resource: string; decision: string }>;
      expect(linhas.some((l) => l.userId === U.semCelula && l.resource === 'permission_management')).toBe(true);
    });

    it('`limit` acima do teto → 400 (o teto é contrato)', async () => {
      expect((await chamar('/api/admin/permission-audit?limit=5000', U.gestora)).status).toBe(400);
    });

    it('🔴 `?userId=` no GET NÃO filtra mais — zod descarta a chave desconhecida, a rota ignora', async () => {
      // Escolha: ignorar (não 400) — o schema da query não usa `.strict()`, e
      // nenhuma outra query desta família usa; adicionar `.strict()` só aqui
      // seria uma exceção sem motivo local. Prova: um uid que NUNCA apareceu na
      // trilha, e mesmo assim a resposta não fica vazia — se o filtro ainda
      // funcionasse, `entries` seria `[]`.
      const uidFantasma = 'panel-e2e-nao-existe-em-lugar-nenhum';
      const res = await chamar(`/api/admin/permission-audit?userId=${uidFantasma}&limit=50`, U.gestora);

      expect(res.status).toBe(200);
      const linhas = res.body.entries as Array<{ userId: string }>;
      expect(linhas.length).toBeGreaterThan(0);
      expect(linhas.some((l) => l.userId === uidFantasma)).toBe(false);
    });

    it('🔴 staff SEM a célula → 403 na rota, antes mesmo de a função do banco opinar', async () => {
      const res = await chamar('/api/admin/permission-audit', U.semCelula);

      expect(res.status).toBe(403);
      expect(res.body.entries).toBeUndefined();
    });

    it('🔴 `POST .../query` também exige a célula — staff SEM ela → 403', async () => {
      const res = await chamarPost('/api/admin/permission-audit/query', U.semCelula, { limit: 10 });

      expect(res.status).toBe(403);
      expect(res.body.entries).toBeUndefined();
    });
  });
});
