import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { Pool } from 'pg';

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
  let server: Server;
  let baseUrl: string;

  const TENANT = '00000000-0000-0000-0000-000000000001';
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

  function token(uid: string, role = 'admin'): string {
    const dados = Buffer.from(JSON.stringify({ uid, email: `${uid}@e2e.local`, role })).toString('base64');
    return `Bearer mock_${dados}`;
  }

  async function chamar(
    metodo: string,
    caminho: string,
    uid: string | null,
    role = 'admin',
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${baseUrl}${caminho}`, {
      method: metodo,
      headers: uid ? { Authorization: token(uid, role) } : {},
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  async function limpar(): Promise<void> {
    const uids = Object.values(U);
    await pool.query(`DELETE FROM iam.permission_audit_log WHERE user_id = ANY($1)`, [uids]);
    await pool.query(
      `DELETE FROM iam.permission_group_changes WHERE group_id IN
         (SELECT id FROM iam.permission_groups WHERE name = ANY($1))`,
      [[GRUPO_GESTAO, GRUPO_SEM_CELULA]],
    );
    await pool.query(`DELETE FROM iam.user_groups WHERE user_id = ANY($1)`, [uids]);
    await pool.query(`DELETE FROM iam.group_permissions WHERE group_id IN
      (SELECT id FROM iam.permission_groups WHERE name = ANY($1))`, [[GRUPO_GESTAO, GRUPO_SEM_CELULA]]);
    await pool.query(`DELETE FROM iam.permission_groups WHERE name = ANY($1)`, [[GRUPO_GESTAO, GRUPO_SEM_CELULA]]);
    await pool.query(`DELETE FROM users WHERE firebase_uid = ANY($1)`, [uids]);
  }

  /** Cria grupo + células + membros como superuser (o painel usa a mig 279; aqui é só semeadura). */
  async function semear(): Promise<void> {
    await pool.query(
      `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES
         ($1, 'perm-gestora@e2e.local',  'admin',     'ACTIVE', true,  $5),
         ($2, 'perm-semcel@e2e.local',   'admin',     'ACTIVE', true,  $5),
         ($3, 'perm-semgrupo@e2e.local', 'admin',     'ACTIVE', true,  $5),
         ($4, 'perm-admissao@e2e.local', 'admin',     'PENDING_ONBOARDING', true, $5)`,
      [U.gestora, U.semCelula, U.semGrupo, U.emAdmissao, TENANT],
    );

    const gestao = await pool.query(
      `INSERT INTO iam.permission_groups (tenant_id, name, description) VALUES ($1, $2, 'e2e') RETURNING id`,
      [TENANT, GRUPO_GESTAO],
    );
    grupoGestaoId = gestao.rows[0].id;
    const semCelula = await pool.query(
      `INSERT INTO iam.permission_groups (tenant_id, name, description) VALUES ($1, $2, 'e2e') RETURNING id`,
      [TENANT, GRUPO_SEM_CELULA],
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
      [U.gestora, grupoGestaoId, U.emAdmissao, TENANT],
    );
    await pool.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [
      U.semCelula,
      semCelula.rows[0].id,
      TENANT,
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

    const express = (await import('express')).default;
    const { correlationMiddleware } = await import('@shared/logging/correlationMiddleware');
    const { dbSessionMiddleware } = await import('@shared/database/dbSessionMiddleware');
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    const {
      AuthMiddleware,
      PermissionMiddleware,
      SimplifiedAuthorizationEngine,
      createAdminUsersRoutes,
      mockAuthMiddleware,
    } = await import('@modules/identity');
    const { createPermissionsModule } = await import('@modules/identity/permissions');

    const db = DatabaseConnection.getInstance();
    const permissions = createPermissionsModule({
      pool: db.getPool(),
      systemPool: db.getSystemPool(),
      staffRoles: ['admin', 'recruiter', 'community_manager'],
      ttlMs: 0,
    });

    const auth = new AuthMiddleware(
      { parseCredentials: () => null, authenticate: async () => null } as never,
      new SimplifiedAuthorizationEngine(),
      permissions.client,
    );
    const permissionMiddleware = new PermissionMiddleware({
      client: permissions.client,
      audit: permissions.repositories.audit,
    });

    // Só o controller é substituído — ver o cabeçalho.
    const controller = {
      createAdminUser: (_req: unknown, res: { json: (b: unknown) => void }) => res.json({ chegou: 'createAdminUser' }),
      listAdminUsers: (_req: unknown, res: { json: (b: unknown) => void }) => res.json({ chegou: 'listAdminUsers' }),
      deleteAdminUser: (_req: unknown, res: { json: (b: unknown) => void }) => res.json({ chegou: 'deleteAdminUser' }),
      deleteUserByEmail: (_req: unknown, res: { json: (b: unknown) => void }) => res.json({ chegou: 'deleteUserByEmail' }),
      resetAdminPassword: (_req: unknown, res: { json: (b: unknown) => void }) => res.json({ chegou: 'resetAdminPassword' }),
      updateAdminRole: (_req: unknown, res: { json: (b: unknown) => void }) => res.json({ chegou: 'updateAdminRole' }),
    };

    const app = express();
    app.use(express.json());
    app.use(correlationMiddleware);
    app.use(dbSessionMiddleware);
    app.use(mockAuthMiddleware);
    app.use('/api/admin', createAdminUsersRoutes(controller as never, auth, permissionMiddleware));

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 30000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
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

  it('mexer em PAPEL exige permission_management:write — user_management não basta', async () => {
    // A gestora tem user_management:* inteiro e mesmo assim é barrada aqui: é a
    // fronteira do lex C1 (quem muda acesso é um conjunto menor de gente).
    const res = await chamar('PATCH', '/api/admin/users/abc/role', U.gestora);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'missing_cell' });
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
    const cacheado = createComTtl();
    try {
      expect((await cacheado.chamar()).status).toBe(200);

      const permissao = await pool.query(
        `SELECT id FROM iam.permissions WHERE resource = 'user_management' AND action = 'read'`,
      );
      await pool.query(`DELETE FROM iam.group_permissions WHERE group_id = $1 AND permission_id = $2`, [
        grupoGestaoId,
        permissao.rows[0].id,
      ]);

      // Sem invalidar, o cache ainda responde a decisão antiga (a janela do TTL).
      expect((await cacheado.chamar()).status).toBe(200);

      // É o handler de `permission.changed` que chama isto em produção.
      cacheado.invalidate([U.gestora]);
      expect((await cacheado.chamar()).status).toBe(403);

      await pool.query(`INSERT INTO iam.group_permissions (group_id, permission_id) VALUES ($1, $2)`, [
        grupoGestaoId,
        permissao.rows[0].id,
      ]);
    } finally {
      await cacheado.fechar();
    }
  });

  /** Segunda app, com TTL longo — para observar cache e invalidação. */
  function createComTtl(): {
    chamar: () => Promise<{ status: number }>;
    invalidate: (uids: string[]) => void;
    fechar: () => Promise<void>;
  } {
    let servidorTtl: Server | undefined;
    let urlTtl = '';
    let invalidar: (uids: string[]) => void = () => undefined;

    const pronto = (async () => {
      const express = (await import('express')).default;
      const { correlationMiddleware } = await import('@shared/logging/correlationMiddleware');
      const { dbSessionMiddleware } = await import('@shared/database/dbSessionMiddleware');
      const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
      const { AuthMiddleware, PermissionMiddleware, SimplifiedAuthorizationEngine, createAdminUsersRoutes, mockAuthMiddleware } =
        await import('@modules/identity');
      const { createPermissionsModule } = await import('@modules/identity/permissions');

      const db = DatabaseConnection.getInstance();
      const permissions = createPermissionsModule({
        pool: db.getPool(),
        systemPool: db.getSystemPool(),
        staffRoles: ['admin', 'recruiter', 'community_manager'],
        ttlMs: 60_000,
      });
      invalidar = (uids) => permissions.client.invalidate(uids);

      const app = express();
      app.use(correlationMiddleware);
      app.use(dbSessionMiddleware);
      app.use(mockAuthMiddleware);
      app.use(
        '/api/admin',
        createAdminUsersRoutes(
          { listAdminUsers: (_r: unknown, res: { json: (b: unknown) => void }) => res.json({ ok: true }) } as never,
          new AuthMiddleware(
            { parseCredentials: () => null, authenticate: async () => null } as never,
            new SimplifiedAuthorizationEngine(),
            permissions.client,
          ),
          new PermissionMiddleware({ client: permissions.client, audit: permissions.repositories.audit }),
        ),
      );
      const servidor = app.listen(0);
      await new Promise<void>((resolve) => servidor.once('listening', () => resolve()));
      servidorTtl = servidor;
      urlTtl = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
    })();

    return {
      chamar: async () => {
        await pronto;
        const res = await fetch(`${urlTtl}/api/admin/users`, { headers: { Authorization: token(U.gestora) } });
        return { status: res.status };
      },
      invalidate: (uids) => invalidar(uids),
      fechar: async () => {
        await pronto;
        await new Promise<void>((resolve) => servidorTtl?.close(() => resolve()));
      },
    };
  }
});
