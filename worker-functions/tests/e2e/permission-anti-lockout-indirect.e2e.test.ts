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
 * ANTI-LOCKOUT PELOS CAMINHOS INDIRETOS (migration 410) — banco real, HTTP real.
 *
 * A 279 protege o último gestor só nas três operações do painel. Esta suíte
 * prova os caminhos que ficavam de fora (spec 002 §fora-de-escopo; lex C8):
 *   (b)  `DELETE FROM users` do último gestor — o trigger recusa, como app_runtime;
 *   (b') `UPDATE users SET status` que tira o último gestor de ACTIVE — idem;
 *   (c)  `deprecate_missing_permission_cells` com a família de gestão fora da
 *        lista viva — a família fica; outra célula (controle positivo) cai;
 *   (a)  `PATCH /users/:id/role` — NÃO é lockout: gestor troca de papel e
 *        continua gestor no IAM. Prova, não trava.
 *   (b-HTTP) `DELETE /api/admin/users/:id` do último gestor → 409 `last_manager`,
 *        e a linha continua (pré-checagem ANTES do Firebase).
 *
 * ⚠️ Toda alínea afirma o erro E a ausência de efeito no banco. Só o status
 * seria régua de forma.
 * ⚠️ O engine fica DESLIGADO: o que reprova aqui reprovou no BANCO ou no use
 * case, nunca no filtro de rota.
 */

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('410 — anti-lockout pelos caminhos indiretos', () => {
  let admin: Pool;
  let runtime: Pool;
  let system: Pool;
  let app: AppDeFamilia;

  const U = {
    unico: 'lock-e2e-gestor-unico',
    segundo: 'lock-e2e-gestor-segundo',
    comum: 'lock-e2e-comum',
  };
  const G = { gestao: 'Lock E2E Gestão', comum: 'Lock E2E Comum' };
  const CELULA_TESTE = { resource: 'lock_e2e', action: 'read' };
  let idGestao: string;

  const envAnterior: Record<string, string | undefined> = {};
  function setEnv(chave: string, valor: string): void {
    envAnterior[chave] = process.env[chave];
    process.env[chave] = valor;
  }

  async function gestoresVivos(): Promise<string[]> {
    const r = await admin.query(
      `SELECT u.firebase_uid FROM users u
        WHERE u.status = 'ACTIVE'
          AND 'permission_management:write' = ANY (iam.effective_permissions(u.firebase_uid, $1))
          AND u.firebase_uid LIKE 'lock-e2e-%'
        ORDER BY 1`,
      [TENANT_E2E],
    );
    return r.rows.map((x) => x.firebase_uid as string);
  }

  async function limpar(): Promise<void> {
    // Membership antes de users: a limpeza não pode tropeçar na própria trava.
    await limparIamFixtures(admin, { uids: Object.values(U), grupos: Object.values(G) });
    await admin.query(`DELETE FROM iam.permissions WHERE resource = $1`, [CELULA_TESTE.resource]);
  }

  async function chamar(
    metodo: string,
    caminho: string,
    uid: string,
    corpo?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${app.url}${caminho}`, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', Authorization: tokenMock(uid) },
      ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });
    runtime = new Pool({ connectionString: DATABASE_URL, options: '-c role=app_runtime' });
    system = new Pool({ connectionString: DATABASE_URL, options: '-c role=app_system' });
    await limpar();

    await admin.query(
      `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES
         ($1, 'lock-unico@e2e.local',   'admin',     'ACTIVE', true, $4),
         ($2, 'lock-segundo@e2e.local', 'admin',     'ACTIVE', true, $4),
         ($3, 'lock-comum@e2e.local',   'recruiter', 'ACTIVE', true, $4)`,
      [U.unico, U.segundo, U.comum, TENANT_E2E],
    );
    idGestao = await grupoComCelulas(admin, {
      nome: G.gestao,
      uid: U.unico,
      celulas: [
        ['permission_management', 'write'],
        ['permission_management', 'read'],
        ['user_management', 'delete'],
      ],
    });
    await grupoComCelulas(admin, { nome: G.comum, uid: U.comum, celulas: [['vacancy', 'read']] });

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'false');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);
    setEnv('NODE_ENV', 'test');

    const identity = await import('@modules/identity');
    const { AdminController } = await import('@modules/identity/interfaces/controllers/AdminController');
    app = await montarAppDeFamilia({
      montarRotas: ({ app: express, auth, permissions }) =>
        express.use('/api/admin', identity.createAdminUsersRoutes(new AdminController(), auth, permissions)),
    });
  }, 30000);

  afterAll(async () => {
    await app?.fechar();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await limpar();
    await runtime.end();
    await system.end();
    await admin.end();
    for (const [chave, valor] of Object.entries(envAnterior)) {
      if (valor === undefined) delete process.env[chave];
      else process.env[chave] = valor;
    }
  });

  describe('(b) DELETE FROM users — o trigger é a tranca, e vale para app_runtime', () => {
    it('o ÚNICO gestor não sai; a linha e a membership continuam', async () => {
      expect(await gestoresVivos()).toEqual([U.unico]);
      await expect(runtime.query(`DELETE FROM users WHERE firebase_uid = $1`, [U.unico])).rejects.toMatchObject({
        code: '23514',
        message: expect.stringContaining('anti-lockout'),
      });
      expect(await gestoresVivos()).toEqual([U.unico]);
      const vinculo = await admin.query(
        `SELECT 1 FROM iam.user_groups WHERE user_id = $1 AND group_id = $2 AND removed_at IS NULL`,
        [U.unico, idGestao],
      );
      expect(vinculo.rowCount).toBe(1);
    });

    it('controle positivo: com um SEGUNDO gestor, o primeiro pode ser apagado — e o segundo fica', async () => {
      await admin.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [
        U.segundo,
        idGestao,
        TENANT_E2E,
      ]);
      expect(await gestoresVivos()).toEqual([U.unico, U.segundo].sort());

      await runtime.query(`DELETE FROM users WHERE firebase_uid = $1`, [U.unico]);

      expect(await gestoresVivos()).toEqual([U.segundo]);
      // e agora o segundo virou o único: a trava o segue
      await expect(runtime.query(`DELETE FROM users WHERE firebase_uid = $1`, [U.segundo])).rejects.toMatchObject({
        code: '23514',
      });

      // repõe o primeiro para as alíneas seguintes
      await admin.query(
        `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id)
         VALUES ($1, 'lock-unico@e2e.local', 'admin', 'ACTIVE', true, $2)`,
        [U.unico, TENANT_E2E],
      );
      await admin.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [
        U.unico,
        idGestao,
        TENANT_E2E,
      ]);
      await admin.query(`UPDATE iam.user_groups SET removed_at = now() WHERE user_id = $1`, [U.segundo]);
      expect(await gestoresVivos()).toEqual([U.unico]);
    });

    it('quem NÃO é gestor sai sem a trava (ela não é um freio geral em users)', async () => {
      await runtime.query(`DELETE FROM users WHERE firebase_uid = $1`, [U.comum]);
      const sobrou = await admin.query(`SELECT 1 FROM users WHERE firebase_uid = $1`, [U.comum]);
      expect(sobrou.rowCount).toBe(0);
      await admin.query(
        `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id)
         VALUES ($1, 'lock-comum@e2e.local', 'recruiter', 'ACTIVE', true, $2)`,
        [U.comum, TENANT_E2E],
      );
    });
  });

  describe("(b') UPDATE users SET status — sair de ACTIVE é sair do IAM", () => {
    it('desativar o único gestor é recusado; o status continua ACTIVE', async () => {
      await expect(
        runtime.query(`UPDATE users SET status = 'DEACTIVATED' WHERE firebase_uid = $1`, [U.unico]),
      ).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('anti-lockout') });
      const r = await admin.query(`SELECT status FROM users WHERE firebase_uid = $1`, [U.unico]);
      expect(r.rows[0].status).toBe('ACTIVE');
    });

    it('UPDATE que NÃO mexe no status (nem sai de ACTIVE) passa', async () => {
      await runtime.query(`UPDATE users SET display_name = 'Gestor Único' WHERE firebase_uid = $1`, [U.unico]);
      await runtime.query(`UPDATE users SET status = 'ACTIVE' WHERE firebase_uid = $1`, [U.unico]);
      expect(await gestoresVivos()).toEqual([U.unico]);
    });
  });

  describe('(c) deprecate_missing_permission_cells — a família de gestão não se descontinua', () => {
    it('lista viva SEM permission_management: as duas células ficam; a célula de teste cai', async () => {
      const client = await system.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.system_context', 'e2e-410', true)`);
        await client.query(
          `SELECT iam.sync_permission_cell($1, $2, 'célula de teste 410', 'Teste', 'worker-functions')`,
          [CELULA_TESTE.resource, CELULA_TESTE.action],
        );
        const n = await client.query<{ n: number }>(
          `SELECT iam.deprecate_missing_permission_cells('worker-functions', $1::text[]) AS n`,
          [['worker:read']],
        );
        expect(Number(n.rows[0].n)).toBeGreaterThanOrEqual(1);
        const estado = await client.query<{ k: string; dep: string | null }>(
          `SELECT resource || ':' || action AS k, deprecated_at AS dep
             FROM iam.permissions
            WHERE resource IN ('permission_management', $1)
            ORDER BY 1`,
          [CELULA_TESTE.resource],
        );
        const porChave = Object.fromEntries(estado.rows.map((r) => [r.k, r.dep]));
        expect(porChave['permission_management:read']).toBeNull();
        expect(porChave['permission_management:write']).toBeNull();
        expect(porChave['lock_e2e:read']).not.toBeNull();
        // e o gestor continua gestor, mesmo com o catálogo "varrido"
        const g = await client.query(
          `SELECT 'permission_management:write' = ANY (iam.effective_permissions($1, $2)) AS ok`,
          [U.unico, TENANT_E2E],
        );
        expect(g.rows[0].ok).toBe(true);
      } finally {
        // ROLLBACK: nada disto sobrevive — o catálogo compartilhado do banco de e2e fica intacto.
        await client.query('ROLLBACK');
        client.release();
      }
    });
  });

  describe('(a) PATCH /users/:id/role — não é lockout; provado, não travado', () => {
    it('o único gestor troca de papel e continua gestor no IAM', async () => {
      const res = await chamar('PATCH', `/api/admin/users/${U.unico}/role`, U.unico, { role: 'recruiter' });
      expect(res.status).toBe(200);
      const r = await admin.query(`SELECT role FROM users WHERE firebase_uid = $1`, [U.unico]);
      expect(r.rows[0].role).toBe('recruiter');
      expect(await gestoresVivos()).toEqual([U.unico]);
      await admin.query(`UPDATE users SET role = 'admin' WHERE firebase_uid = $1`, [U.unico]);
    });
  });

  describe('(b-HTTP) DELETE /api/admin/users/:id — 409 antes de tocar no Firebase', () => {
    it('último gestor → 409 `last_manager`, a linha continua', async () => {
      const res = await chamar('DELETE', `/api/admin/users/${U.unico}`, U.unico);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ success: false, code: 'last_manager' });
      expect(await gestoresVivos()).toEqual([U.unico]);
    });
  });
});
