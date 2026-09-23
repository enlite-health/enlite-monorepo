import { Pool } from 'pg';
import {
  TENANT_E2E,
  tokenMock,
  montarAppComTodasFamilias,
  controllerStub,
  type AppComTodasFamilias,
} from './helpers/permissionFamilyHarness';

/**
 * `/v1/me/simulation*` — HTTP REAL, BANCO REAL (spec 026, D407, T2.6).
 *
 * Molde: `tests/e2e/permission-enforcement-admin-users.test.ts` (a "primeira
 * família virada" — mesmo harness `montarAppComTodasFamilias`, mesmo jeito de
 * autenticar via `tokenMock`/`USE_MOCK_AUTH`, mesmo jeito de ligar o engine
 * ABAC + marcar `iam.rollout_state` antes do boot). A fixture de grupo/célula
 * (grupo vivo com UMA célula real, grupo arquivado, ator membro real do
 * Acesso Master) copia `tests/e2e/group-simulation.e2e.test.ts` (F1, SQL puro)
 * — aqui a MESMA fixture é exercitada pela ROTA, não pela função SQL direto.
 *
 * `PERMISSION_CACHE_TTL_MS=0` (mesmo valor de TODOS os e2e de família neste
 * repo — `permission-enforcement-*.test.ts`, `permission-enforcement-all-
 * families.e2e.test.ts`): `montarAppComTodasFamilias` liga
 * `wirePermissionsModule` com `events: { registerHandler: () => {} }` — um
 * registry NO-OP. O `DomainEventProcessor` real (quem consome `domain_events`
 * e chama `client.invalidate()`) nunca roda neste harness; com TTL > 0 e sem
 * consumidor, o cache SEMPRE pareceria "não invalidou" — um defeito do
 * HARNESS, não do código. Por isso TTL=0 aqui: o que se prova é que o BANCO
 * reflete `start`/`end` imediatamente (o invariante que realmente importa),
 * não a latência de invalidação entre instâncias Cloud Run (fora do alcance
 * deste harness — e de todo e2e de família já existente no repo).
 *
 * ⚠️ Mock do jest é PROIBIDO neste arquivo (mesma regra do molde): a ÚNICA
 * substituição é o controller de `/api/admin/users` (via `controllerStub`,
 * que TODAS as 9 suítes de família já usam) — case 4 só precisa que a request
 * NUNCA chegue lá.
 */

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const MASTER_ID = 'a0000000-0000-0000-0000-000000000001';
const INTERNAL_SECRET = 'e2e-me-simulation-internal-secret';

const PREFIXO = 'e2e-mesim-';
const U = {
  /** Membro VIVO do Acesso Master — filiação real, exigida por `iam.is_master_member`. */
  master: `${PREFIXO}master`,
  /** Staff ACTIVE, nunca no Master — caso 1. */
  staff: `${PREFIXO}staff`,
};
const GROUP_VIVO = 'E2E MeSim Grupo Vivo 026';
const GROUP_ARQUIVADO = 'E2E MeSim Grupo Arquivado 026';

describe('/v1/me/simulation* — HTTP real, banco real (spec 026, D407)', () => {
  let pool: Pool;
  let app: AppComTodasFamilias;
  let groupVivoId: string;
  let groupArquivadoId: string;
  let masterGroupName: string;
  /** Estado que atravessa os casos 3 → 4 → 5 (a simulação aberta no caso 3). */
  let simulationId: string;

  const envAnterior: Record<string, string | undefined> = {};
  function setEnv(chave: string, valor: string): void {
    envAnterior[chave] = process.env[chave];
    process.env[chave] = valor;
  }
  function restaurarEnv(): void {
    for (const [chave, valor] of Object.entries(envAnterior)) {
      if (valor === undefined) delete process.env[chave];
      else process.env[chave] = valor;
    }
  }

  async function chamar(
    metodo: string,
    caminho: string,
    uid: string | null,
    body?: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${app.url}${caminho}`, {
      method: metodo,
      headers: {
        'Content-Type': 'application/json',
        ...(uid ? { Authorization: tokenMock(uid) } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const texto = await res.text();
    return { status: res.status, body: texto ? (JSON.parse(texto) as Record<string, unknown>) : {} };
  }

  /** Ordem das FKs: trilha (simulation_id → group_simulations) → simulação → célula → vínculo → grupo → usuário. */
  async function limpar(): Promise<void> {
    const uids = Object.values(U);
    await pool.query(`DELETE FROM iam.permission_audit_log WHERE user_id = ANY($1)`, [uids]);
    await pool.query(`DELETE FROM iam.group_simulations WHERE user_id = ANY($1)`, [uids]);
    await pool.query(
      `DELETE FROM iam.group_permissions WHERE group_id IN
         (SELECT id FROM iam.permission_groups WHERE tenant_id = $1 AND name = ANY($2))`,
      [TENANT_E2E, [GROUP_VIVO, GROUP_ARQUIVADO]],
    );
    await pool.query(`DELETE FROM iam.user_groups WHERE user_id = ANY($1)`, [uids]);
    await pool.query(`DELETE FROM iam.permission_groups WHERE tenant_id = $1 AND name = ANY($2)`, [
      TENANT_E2E,
      [GROUP_VIVO, GROUP_ARQUIVADO],
    ]);
    await pool.query(`DELETE FROM users WHERE firebase_uid = ANY($1)`, [uids]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    // Idempotente em banco reutilizado (L9) — limpa ANTES de semear também.
    await limpar();

    await pool.query(
      `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES
         ($1, 'e2e-mesim-master@e2e.local', 'admin', 'ACTIVE', true, $3),
         ($2, 'e2e-mesim-staff@e2e.local',  'admin', 'ACTIVE', true, $3)`,
      [U.master, U.staff, TENANT_E2E],
    );
    // master: filiação REAL e viva no Acesso Master.
    await pool.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [
      U.master,
      MASTER_ID,
      TENANT_E2E,
    ]);

    const gVivo = await pool.query<{ id: string }>(
      `INSERT INTO iam.permission_groups (tenant_id, name, description, is_system) VALUES ($1, $2, 'e2e 026 http — vivo', false) RETURNING id`,
      [TENANT_E2E, GROUP_VIVO],
    );
    groupVivoId = gVivo.rows[0].id;
    const gArq = await pool.query<{ id: string }>(
      `INSERT INTO iam.permission_groups (tenant_id, name, description, is_system, archived_at) VALUES ($1, $2, 'e2e 026 http — arquivado', false, now()) RETURNING id`,
      [TENANT_E2E, GROUP_ARQUIVADO],
    );
    groupArquivadoId = gArq.rows[0].id;

    // Uma célula REAL (worker:read) — NÃO user_management:read (a do caso 4) — no grupo vivo.
    const workerRead = await pool.query<{ id: string }>(
      `SELECT id FROM iam.permissions WHERE resource = 'worker' AND action = 'read' AND deprecated_at IS NULL`,
    );
    expect(workerRead.rowCount).toBe(1); // premissa: a célula do catálogo existe
    await pool.query(`INSERT INTO iam.group_permissions (group_id, permission_id) VALUES ($1, $2)`, [
      groupVivoId,
      workerRead.rows[0].id,
    ]);

    const masterGroup = await pool.query<{ name: string }>(`SELECT name FROM iam.permission_groups WHERE id = $1`, [
      MASTER_ID,
    ]);
    masterGroupName = masterGroup.rows[0].name;

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.users');
    // Ver o comentário do cabeçalho — TTL=0 é o molde de TODO e2e de família.
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);

    // Marcador do rollout — sem ele `runPermissionsBootTasks` recusa o boot com
    // o engine ligado (`RolloutNotMigratedError`, task 3.7).
    await pool.query(
      `INSERT INTO iam.rollout_state (key, value, note) VALUES ('permission_groups_migrated', 'done', 'e2e-me-simulation-route')
       ON CONFLICT (key) DO UPDATE SET value = 'done'`,
    );

    // Resolvido ANTES de `montarAppComTodasFamilias` — `montarRotas` é síncrona.
    const identity = await import('@modules/identity');
    const permissionsModule = await import('@modules/identity/permissions');

    app = await montarAppComTodasFamilias({
      internalSecret: INTERNAL_SECRET,
      montarRotas: ({ app: expressApp, auth, permissions, modulo }) => {
        expressApp.use(
          '/api/admin',
          identity.createAdminUsersRoutes(controllerStub('adminUsers') as never, auth, permissions),
        );
        expressApp.use(
          '/v1',
          permissionsModule.createMeAuthzRouter({
            getMyAuthz: modulo.authz,
            staffGuard: auth.requireStaff(),
            uidOf: identity.principalUid,
          }),
        );
        expressApp.use(
          '/v1',
          permissionsModule.createMeSimulationRouter({
            listGroups: modulo.simulation.list,
            startSimulation: modulo.simulation.start,
            endSimulation: modulo.simulation.end,
            client: modulo.client,
            staffGuard: auth.requireStaff(),
            uidOf: identity.principalUid,
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
    await pool.query(`DELETE FROM iam.rollout_state WHERE key = 'permission_groups_migrated'`);
    await pool.end();
    restaurarEnv();
  });

  it('(1) staff NÃO-Master é barrado nas duas rotas — 403 not_master_member', async () => {
    const post = await chamar('POST', '/v1/me/simulation', U.staff, { groupId: groupVivoId });
    expect(post.status).toBe(403);
    expect(post.body).toEqual({ code: 'not_master_member' });

    const get = await chamar('GET', '/v1/me/simulation/groups', U.staff);
    expect(get.status).toBe(403);
    expect(get.body).toEqual({ code: 'not_master_member' });
  });

  it('(2) Master, grupo ARQUIVADO → 422 group_not_simulable', async () => {
    const res = await chamar('POST', '/v1/me/simulation', U.master, { groupId: groupArquivadoId });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ code: 'group_not_simulable' });
  });

  it('(3) Master, grupo vivo G → 201 no shape do contrato, e /v1/me/authz reflete G (não o Master)', async () => {
    const post = await chamar('POST', '/v1/me/simulation', U.master, { groupId: groupVivoId });
    expect(post.status).toBe(201);
    expect(post.body).toMatchObject({
      id: expect.any(String),
      groupId: groupVivoId,
      groupName: GROUP_VIVO,
      startedAt: expect.any(String),
      expiresAt: expect.any(String),
    });
    expect(new Date(post.body.expiresAt as string).getTime()).toBeGreaterThan(
      new Date(post.body.startedAt as string).getTime(),
    );
    simulationId = post.body.id as string;

    const authz = await chamar('GET', '/v1/me/authz', U.master);
    expect(authz.status).toBe(200);
    expect(authz.body.groups).toEqual([{ id: groupVivoId, name: GROUP_VIVO }]);
    expect(authz.body.canSimulate).toBe(true);
    expect((authz.body.simulation as Record<string, unknown>)?.id).toBe(simulationId);
    // As células são as de G (worker:read) — NUNCA as do Master (que tem dezenas, inclusive
    // permission_management:write).
    expect(authz.body.permissions).toEqual(['worker:read']);
  });

  it('(4) rota de negócio sem a célula de G → 403 missing_cell, com simulation_id na trilha', async () => {
    const res = await chamar('GET', '/api/admin/users', U.master);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'missing_cell' });

    // `record()` é fire-and-forget (PgPermissionAuditRepository.ts:9-11) — poll até a linha chegar.
    let linha: { simulation_id: string | null } | undefined;
    for (let i = 0; i < 60; i += 1) {
      const r = await pool.query<{ simulation_id: string | null }>(
        `SELECT simulation_id FROM iam.permission_audit_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [U.master],
      );
      linha = r.rows[0];
      if (linha) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    expect(linha?.simulation_id).toBe(simulationId);
  });

  it('(5) DELETE encerra (204 duas vezes) — /v1/me/authz volta ao Master real', async () => {
    const del1 = await chamar('DELETE', '/v1/me/simulation', U.master);
    expect(del1.status).toBe(204);
    const del2 = await chamar('DELETE', '/v1/me/simulation', U.master);
    expect(del2.status).toBe(204);

    const authz = await chamar('GET', '/v1/me/authz', U.master);
    expect(authz.status).toBe(200);
    expect(authz.body.simulation).toBeNull();
    expect(authz.body.groups).toEqual([{ id: MASTER_ID, name: masterGroupName }]);
  });

  it('(6) POST com groupId = o próprio Acesso Master → 422 group_not_simulable', async () => {
    const res = await chamar('POST', '/v1/me/simulation', U.master, { groupId: MASTER_ID });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ code: 'group_not_simulable' });
  });
});
