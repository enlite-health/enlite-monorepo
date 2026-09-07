import { Pool } from 'pg';
import {
  TENANT_E2E,
  tokenMock,
  montarAppDeFamilia,
  limparIamFixtures,
  type AppDeFamilia,
} from './helpers/permissionFamilyHarness';

/**
 * A PRIMEIRA FAMÍLIA VIRADA — HTTP REAL, BANCO REAL (task 3.8, design 6).
 *
 * A spec `permission-enforcement` diz que nenhuma rota vira sem "prova
 * automatizada de que a negação funciona para um staff sem a célula". Esta é a
 * prova da família `admin.users`.
 *
 * O que sobe aqui é a CADEIA DE VERDADE do `src/index.ts` — `correlationMiddleware`
 * → `dbSessionMiddleware` → `mockAuthMiddleware` → `AuthMiddleware` (com o
 * `PermissionClient` de produção, resolvendo contra `iam.effective_permissions`)
 * → `PermissionMiddleware` → `createAdminUsersRoutes` — numa porta efêmera. Grupos,
 * membros e células são criados pelas funções `SECURITY DEFINER` da mig 279, que é
 * como o painel vai criá-los.
 *
 * ⚠️ Mock do jest é PROIBIDO neste arquivo: mockar qualquer peça apagaria
 * justamente a camada sob teste. A ÚNICA substituição é o `AdminController`
 * (precisa de Firebase Admin, e não é o objeto do teste): os handlers devolvem
 * 200 com um marcador, então "passou" e "não passou" são inequívocos.
 *
 * ⚠️ As envs de flag são escritas ANTES do primeiro import de `src/`, por isso
 * todo o `src/` entra por `await import()` dentro do `beforeAll`.
 */

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('família admin.users sob a decisão real por célula (HTTP real, banco real)', () => {
  let pool: Pool;
  let app: AppDeFamilia;
  const U = {
    /** Tem `user_management:*` — o gestor de acesso. */
    gestora: 'perm-e2e-gestora',
    /** Staff ativo, em grupo SEM as células de usuário. */
    semCelula: 'perm-e2e-sem-celula',
    /** Staff ativo e sem nenhum grupo — o caso da tela de boas-vindas. */
    semGrupo: 'perm-e2e-sem-grupo',
    /** Tem a célula, mas a conta ainda não foi ativada. */
    emAdmissao: 'perm-e2e-em-admissao',
  };
  const GRUPO_GESTAO = 'Perm E2E Gestão de Acessos';
  const GRUPO_SEM_CELULA = 'Perm E2E Sem Células';
  let grupoGestaoId: string;

  const envAnterior: Record<string, string | undefined> = {};
  function setEnv(chave: string, valor: string): void {
    envAnterior[chave] = process.env[chave];
    process.env[chave] = valor;
  }

  async function chamar(
    metodo: string,
    caminho: string,
    uid: string | null,
    role = 'admin',
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${app.url}${caminho}`, {
      method: metodo,
      headers: uid ? { Authorization: tokenMock(uid, role) } : {},
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  async function limpar(): Promise<void> {
    await limparIamFixtures(pool, {
      uids: Object.values(U),
      grupos: [GRUPO_GESTAO, GRUPO_SEM_CELULA],
    });
  }

  /** Cria grupo + células + membros como superuser (o painel usa a mig 279; aqui é só semeadura). */
  async function semear(): Promise<void> {
    await pool.query(
      `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES
         ($1, 'perm-gestora@e2e.local',  'admin',     'ACTIVE', true,  $5),
         ($2, 'perm-semcel@e2e.local',   'admin',     'ACTIVE', true,  $5),
         ($3, 'perm-semgrupo@e2e.local', 'admin',     'ACTIVE', true,  $5),
         ($4, 'perm-admissao@e2e.local', 'admin',     'PENDING_ONBOARDING', true, $5)`,
      [U.gestora, U.semCelula, U.semGrupo, U.emAdmissao, TENANT_E2E],
    );

    const gestao = await pool.query(
      `INSERT INTO iam.permission_groups (tenant_id, name, description) VALUES ($1, $2, 'e2e') RETURNING id`,
      [TENANT_E2E, GRUPO_GESTAO],
    );
    grupoGestaoId = gestao.rows[0].id;
    const semCelula = await pool.query(
      `INSERT INTO iam.permission_groups (tenant_id, name, description) VALUES ($1, $2, 'e2e') RETURNING id`,
      [TENANT_E2E, GRUPO_SEM_CELULA],
    );

    await pool.query(
      `INSERT INTO iam.group_permissions (group_id, permission_id)
         SELECT $1, id FROM iam.permissions WHERE resource = 'user_management'`,
      [grupoGestaoId],
    );
    await pool.query(
      `INSERT INTO iam.group_permissions (group_id, permission_id)
         SELECT $1, id FROM iam.permissions WHERE resource = 'vacancy' AND action = 'read'`,
      [semCelula.rows[0].id],
    );

    await pool.query(
      `INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $4), ($3, $2, $4)`,
      [U.gestora, grupoGestaoId, U.emAdmissao, TENANT_E2E],
    );
    await pool.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [
      U.semCelula,
      semCelula.rows[0].id,
      TENANT_E2E,
    ]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();
    await semear();

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.users');
    // Cache zerado: cada request resolve de novo — é o que torna observável o
    // requisito "mudança de grupo vale na PRÓXIMA request".
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);

    const { createAdminUsersRoutes } = await import('@modules/identity');

    // Só o controller é substituído — ver o cabeçalho.
    const controller = {
      createAdminUser: (_req: unknown, res: { json: (b: unknown) => void }) => res.json({ chegou: 'createAdminUser' }),
      listAdminUsers: (_req: unknown, res: { json: (b: unknown) => void }) => res.json({ chegou: 'listAdminUsers' }),
      deleteAdminUser: (_req: unknown, res: { json: (b: unknown) => void }) => res.json({ chegou: 'deleteAdminUser' }),
      deleteUserByEmail: (_req: unknown, res: { json: (b: unknown) => void }) => res.json({ chegou: 'deleteUserByEmail' }),
      resetAdminPassword: (_req: unknown, res: { json: (b: unknown) => void }) => res.json({ chegou: 'resetAdminPassword' }),
      updateAdminRole: (_req: unknown, res: { json: (b: unknown) => void }) => res.json({ chegou: 'updateAdminRole' }),
    };

    app = await montarAppDeFamilia({
      montarRotas: ({ app: express, auth, permissions }) =>
        express.use('/api/admin', createAdminUsersRoutes(controller as never, auth, permissions)),
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

  it('staff COM a célula passa e chega no handler', async () => {
    const res = await chamar('GET', '/api/admin/users', U.gestora);
    expect(res).toMatchObject({ status: 200, body: { chegou: 'listAdminUsers' } });
  });

  it('staff SEM a célula → 403, e o handler não roda', async () => {
    const res = await chamar('GET', '/api/admin/users', U.semCelula);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'missing_cell' });
    expect(res.body.chegou).toBeUndefined();
  });

  it('staff sem NENHUM grupo → 403 no_group (não é 200 vazio nem 500)', async () => {
    const res = await chamar('GET', '/api/admin/users', U.semGrupo);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'no_group' });
  });

  it('conta em admissão é negada MESMO tendo a célula', async () => {
    const res = await chamar('GET', '/api/admin/users', U.emAdmissao);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'account_not_active' });
  });

  it('sem credencial → 401 antes de qualquer decisão de permissão', async () => {
    const res = await chamar('GET', '/api/admin/users', null);
    expect(res.status).toBe(401);
  });

  it('a negativa vira linha em iam.permission_audit_log (quem, o quê, quando)', async () => {
    await pool.query(`DELETE FROM iam.permission_audit_log WHERE user_id = $1`, [U.semCelula]);

    await chamar('DELETE', '/api/admin/users/abc-123', U.semCelula);
    // A trilha é assíncrona fail-safe (nunca segura a request) — daí a espera curta.
    await new Promise((r) => setTimeout(r, 300));

    const trilha = await pool.query(
      `SELECT resource, action, decision, resource_id FROM iam.permission_audit_log WHERE user_id = $1`,
      [U.semCelula],
    );
    expect(trilha.rows).toEqual([
      expect.objectContaining({
        resource: 'user_management',
        action: 'delete',
        decision: 'DENY',
        resource_id: 'abc-123',
      }),
    ]);
  });

  it('com a família enforced, o PAPEL não decide: recrutadora com a célula passa por rota que era admin-only', async () => {
    // Antes de 07/09 `POST /users/:id/reset-password` era `requireAdmin()` ANTES da célula:
    // token `recruiter` levava 403 "Admin access required" mesmo com user_management:write.
    // Agora a célula decide sozinha — o guard passa e quem responde é o handler (400: uid não existe).
    const res = await chamar('POST', '/api/admin/users/nao-existe/reset-password', U.gestora, 'recruiter');
    expect(res.status).not.toBe(403);
    expect(res.body.error).not.toBe('Admin access required');
  });

  it('com a família enforced, papel `admin` SEM a célula é negado — o papel não abre mais nada', async () => {
    const res = await chamar('POST', '/api/admin/users/nao-existe/reset-password', U.semCelula, 'admin');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'missing_cell' });
  });

  it('não existe rota de papel (07/09): PATCH /users/:id/role é 404 — acesso se concede por grupo', async () => {
    const res = await chamar('PATCH', '/api/admin/users/abc/role', U.gestora);
    expect(res.status).toBe(404);
  });

  it('célula removida do grupo vale na PRÓXIMA request (sem novo login)', async () => {
    expect((await chamar('GET', '/api/admin/users', U.gestora)).status).toBe(200);

    const permissao = await pool.query(
      `SELECT id FROM iam.permissions WHERE resource = 'user_management' AND action = 'read'`,
    );
    await pool.query(`DELETE FROM iam.group_permissions WHERE group_id = $1 AND permission_id = $2`, [
      grupoGestaoId,
      permissao.rows[0].id,
    ]);

    const depois = await chamar('GET', '/api/admin/users', U.gestora);
    expect(depois.status).toBe(403);

    await pool.query(`INSERT INTO iam.group_permissions (group_id, permission_id) VALUES ($1, $2)`, [
      grupoGestaoId,
      permissao.rows[0].id,
    ]);
    expect((await chamar('GET', '/api/admin/users', U.gestora)).status).toBe(200);
  });

  it('remoção do último grupo corta o acesso na próxima request', async () => {
    expect((await chamar('GET', '/api/admin/users', U.gestora)).status).toBe(200);

    // `removed_by` tem FK para users — o autor é sempre alguém real (por isso
    // o gestor aqui é a própria conta de teste, não uma string solta).
    await pool.query(`UPDATE iam.user_groups SET removed_at = now(), removed_by = $2 WHERE user_id = $1`, [
      U.gestora,
      U.semGrupo,
    ]);
    const depois = await chamar('GET', '/api/admin/users', U.gestora);
    expect(depois.body).toMatchObject({ code: 'no_group' });

    await pool.query(`UPDATE iam.user_groups SET removed_at = NULL, removed_by = NULL WHERE user_id = $1`, [U.gestora]);
    expect((await chamar('GET', '/api/admin/users', U.gestora)).status).toBe(200);
  });

  it('com cache LIGADO, a invalidação por evento é o que faz a revogação valer', async () => {
    // Segunda app, com TTL longo: é a ÚNICA forma de observar a janela em que o
    // cache ainda responde a decisão antiga. A app principal roda com TTL 0.
    const { createAdminUsersRoutes } = await import('@modules/identity');
    const cacheado = await montarAppDeFamilia({
      ttlMs: 60_000,
      montarRotas: ({ app: express, auth, permissions }) =>
        express.use(
          '/api/admin',
          createAdminUsersRoutes(
            { listAdminUsers: (_r: unknown, res: { json: (b: unknown) => void }) => res.json({ ok: true }) } as never,
            auth,
            permissions,
          ),
        ),
    });
    const chamarCacheado = async (): Promise<number> =>
      (await fetch(`${cacheado.url}/api/admin/users`, { headers: { Authorization: tokenMock(U.gestora) } })).status;

    try {
      expect(await chamarCacheado()).toBe(200);

      const permissao = await pool.query(
        `SELECT id FROM iam.permissions WHERE resource = 'user_management' AND action = 'read'`,
      );
      await pool.query(`DELETE FROM iam.group_permissions WHERE group_id = $1 AND permission_id = $2`, [
        grupoGestaoId,
        permissao.rows[0].id,
      ]);

      // Sem invalidar, o cache ainda responde a decisão antiga (a janela do TTL).
      expect(await chamarCacheado()).toBe(200);

      // É o handler de `permission.changed` que chama isto em produção.
      cacheado.invalidar([U.gestora]);
      expect(await chamarCacheado()).toBe(403);

      await pool.query(`INSERT INTO iam.group_permissions (group_id, permission_id) VALUES ($1, $2)`, [
        grupoGestaoId,
        permissao.rows[0].id,
      ]);
    } finally {
      await cacheado.fechar();
    }
  });
});
