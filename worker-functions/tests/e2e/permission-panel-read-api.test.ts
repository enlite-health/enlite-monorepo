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

  async function limpar(): Promise<void> {
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
    await grupoComCelulas(pool, {
      nome: GRUPO_GESTAO,
      uid: U.gestora,
      celulas: [['permission_management', 'read']],
    });
    await grupoComCelulas(pool, {
      nome: GRUPO_SEM_CELULA,
      uid: U.semCelula,
      celulas: [['vacancy', 'read']],
    });

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
        express.use('/api/admin', createPermissionPanelRoutes(modulo.catalog.list, auth, permissions));
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
});
