import { Pool } from 'pg';
import {
  TENANT_E2E,
  tokenMock,
  montarAppComTodasFamilias,
  controllerStub,
  type AppComTodasFamilias,
} from './helpers/permissionFamilyHarness';

/**
 * Cache de `/v1/me/authz` sob TTL LIGADO — propagação de start/end de
 * simulação de grupo (spec 026, D407, F1.x — troca de grupo com feedback).
 *
 * Molde: `tests/e2e/me-simulation-route.e2e.test.ts` (mesmo harness
 * `montarAppComTodasFamilias`, mesma autenticação por `tokenMock`, mesma
 * fixture de grupo vivo com UMA célula real + ator membro real do Acesso
 * Master). A DIFERENÇA deliberada é o TTL: aquele arquivo usa
 * `PERMISSION_CACHE_TTL_MS=0` porque o harness liga
 * `wirePermissionsModule` com `events: { registerHandler: () => {} }` — um
 * registry NO-OP (o `DomainEventProcessor` real, que consome `domain_events`
 * e chama `client.invalidate()`, nunca roda aqui). Este arquivo faz o
 * OPOSTO de propósito: liga o TTL padrão de produção (30000ms) para medir
 * exatamente a lacuna que o TTL=0 do molde contorna — `StartGroupSimulation-
 * UseCase`/`EndGroupSimulationUseCase` publicam `permissionChanged([uid])`
 * (`ports.ts` — "Invalidação de cache entre instâncias, design 4"), mas o
 * publisher (`DomainEventPermissionPublisher`) só ENFILEIRA o evento em
 * `domain_events` — quem limpa o cache é o handler registrado pelo
 * `DomainEventProcessor` ao consumir o outbox. Sem um processor rodando
 * (como é o caso deste harness — e de qualquer request isolada, ANTES do
 * outbox ser drenado), o cache local da MESMA instância que fez a mudança
 * não é invalidado na hora: só expira pelo TTL.
 *
 * Os 3 casos abaixo passam a expectativa DESEJADA (mudança reflete na
 * request seguinte) e devem falhar HOJE, com TTL=30000, exatamente por essa
 * lacuna. Com TTL=0 (GREEN de controle — prova que o teste mede o cache, não
 * outra coisa) os mesmos 3 casos devem passar, porque `resolve()` nunca guarda
 * o resultado (`PermissionService.ts:98` — `if (this.ttlMs > 0)`).
 *
 * Mock do jest é PROIBIDO (mesma regra do molde): a única substituição é o
 * controller de `/api/admin/users` (via `controllerStub`), usado só para o
 * guard de rota ter algo para proteger — nenhum caso deste arquivo chama essa
 * rota.
 */

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const MASTER_ID = 'a0000000-0000-0000-0000-000000000001';
const INTERNAL_SECRET = 'e2e-cache-propagation-internal-secret';

const PREFIXO = 'e2e-cachesim-';
const U = {
  /** Membro VIVO do Acesso Master — filiação real, exigida por `iam.is_master_member`. */
  master: `${PREFIXO}master`,
};
const GROUP_VIVO = 'E2E CacheProp Grupo Vivo 026';

describe('cache de /v1/me/authz sob TTL ligado — propagação de start/end de simulação (spec 026)', () => {
  let pool: Pool;
  let app: AppComTodasFamilias;
  let groupVivoId: string;
  let masterGroupName: string;
  /** `authz.body.permissions` do Master REAL, capturado antes de qualquer simulação — usado nos casos (b)/(c). */
  let masterPermissions: string[];

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
         (SELECT id FROM iam.permission_groups WHERE tenant_id = $1 AND name = $2)`,
      [TENANT_E2E, GROUP_VIVO],
    );
    await pool.query(`DELETE FROM iam.user_groups WHERE user_id = ANY($1)`, [uids]);
    await pool.query(`DELETE FROM iam.permission_groups WHERE tenant_id = $1 AND name = $2`, [
      TENANT_E2E,
      GROUP_VIVO,
    ]);
    await pool.query(`DELETE FROM users WHERE firebase_uid = ANY($1)`, [uids]);
  }

  /** Fecha qualquer simulação aberta do master, sem derrubar as fixtures de grupo/usuário — roda ANTES de cada caso. */
  async function resetSimulacao(): Promise<void> {
    await pool.query(`DELETE FROM iam.permission_audit_log WHERE user_id = ANY($1)`, [Object.values(U)]);
    await pool.query(`DELETE FROM iam.group_simulations WHERE user_id = ANY($1)`, [Object.values(U)]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    // Idempotente em banco reutilizado — limpa ANTES de semear também.
    await limpar();

    await pool.query(
      `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES
         ($1, 'e2e-cachesim-master@e2e.local', 'admin', 'ACTIVE', true, $2)`,
      [U.master, TENANT_E2E],
    );
    // master: filiação REAL e viva no Acesso Master.
    await pool.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [
      U.master,
      MASTER_ID,
      TENANT_E2E,
    ]);

    const gVivo = await pool.query<{ id: string }>(
      `INSERT INTO iam.permission_groups (tenant_id, name, description, is_system) VALUES ($1, $2, 'e2e 026 cache — vivo', false) RETURNING id`,
      [TENANT_E2E, GROUP_VIVO],
    );
    groupVivoId = gVivo.rows[0].id;

    // Uma célula REAL (worker:read) — bem diferente das dezenas do Master, para o teste
    // distinguir "cache serviu o Master" de "cache serviu o grupo simulado" sem ambiguidade.
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
    // TTL LIGADO — o padrão de produção (`DEFAULT_PERMISSION_CACHE_TTL_MS`), ao contrário do
    // molde (`me-simulation-route.e2e.test.ts`), que usa 0. É isto que este arquivo mede.
    setEnv('PERMISSION_CACHE_TTL_MS', '30000');
    setEnv('DATABASE_URL', DATABASE_URL);

    // Marcador do rollout — sem ele `runPermissionsBootTasks` recusa o boot com o engine ligado.
    await pool.query(
      `INSERT INTO iam.rollout_state (key, value, note) VALUES ('permission_groups_migrated', 'done', 'e2e-cache-propagation')
       ON CONFLICT (key) DO UPDATE SET value = 'done'`,
    );

    // Resolvido ANTES de `montarAppComTodasFamilias` — `montarRotas` é síncrona, e o boot lê
    // `PERMISSION_CACHE_TTL_MS` na CONSTRUÇÃO do `PermissionService` (`permissionCacheTtlMs()`).
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

    // Snapshot das permissões do Master REAL, ANTES de qualquer simulação (usado nos casos
    // b/c) — aquece o cache de propósito, para o `beforeEach` de cada caso decidir a partir
    // de um estado conhecido.
    const authzInicial = await chamar('GET', '/v1/me/authz', U.master);
    expect(authzInicial.status).toBe(200);
    expect(authzInicial.body.simulation).toBeNull();
    masterPermissions = authzInicial.body.permissions as string[];
    expect(masterPermissions.length).toBeGreaterThan(0); // premissa: Master tem células reais
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

  beforeEach(resetSimulacao);

  it('(a) start reflete na hora: authz aquecido com simulation=null, POST start, GET imediato já mostra o grupo simulado', async () => {
    // `invalidar()` primeiro — não depende de um cache frio incidental sobrado de outro caso;
    // a leitura seguinte aquece o cache com `simulation: null`, DELIBERADAMENTE, antes de start.
    app.invalidar([U.master]);
    const antes = await chamar('GET', '/v1/me/authz', U.master);
    expect(antes.status).toBe(200);
    expect(antes.body.simulation).toBeNull();

    const post = await chamar('POST', '/v1/me/simulation', U.master, { groupId: groupVivoId });
    expect(post.status).toBe(201);
    const simulationId = post.body.id as string;

    // Nenhuma espera — a requisição seguinte é imediata, como o painel faz ao trocar de grupo.
    const depois = await chamar('GET', '/v1/me/authz', U.master);
    expect(depois.status).toBe(200);
    expect((depois.body.simulation as Record<string, unknown> | null)?.id).toBe(simulationId);
    expect((depois.body.simulation as Record<string, unknown> | null)?.groupId).toBe(groupVivoId);
    expect(depois.body.groups).toEqual([{ id: groupVivoId, name: GROUP_VIVO }]);
    // As células são as do grupo simulado (worker:read) — NUNCA as dezenas do Master.
    expect(depois.body.permissions).toEqual(['worker:read']);
  });

  it('(b) end reflete na hora: com simulação ativa e cache aquecido, DELETE, GET imediato já volta ao Master', async () => {
    const post = await chamar('POST', '/v1/me/simulation', U.master, { groupId: groupVivoId });
    expect(post.status).toBe(201);

    // Precondição "cache aquecido DENTRO da simulação" montada por um caminho CONHECIDO-BOM
    // (`invalidar()`, o mesmo hook que o handler do evento chamaria se o processor rodasse) —
    // de propósito, para NÃO depender do caso (a) (start não propagar) para chegar até aqui.
    // Isto isola (b): o que falha abaixo é SÓ a propagação do END, nunca a do START.
    app.invalidar([U.master]);
    const dentro = await chamar('GET', '/v1/me/authz', U.master);
    expect(dentro.status).toBe(200);
    expect(dentro.body.permissions).toEqual(['worker:read']);

    const del = await chamar('DELETE', '/v1/me/simulation', U.master);
    expect(del.status).toBe(204);

    // SEM invalidar() aqui — é exatamente isto que o produto faz hoje (o handler do evento
    // é quem chamaria `invalidar()`, e não roda neste harness). A pergunta do caso é se o
    // DELETE, sozinho, já basta.
    const depois = await chamar('GET', '/v1/me/authz', U.master);
    expect(depois.status).toBe(200);
    expect(depois.body.simulation).toBeNull();
    expect(depois.body.groups).toEqual([{ id: MASTER_ID, name: masterGroupName }]);
    expect(depois.body.permissions).toEqual(masterPermissions);
  });

  it('(c) o instrumento enxerga o cache: mudança de simulação POR SQL direto (sem passar pela API) também deveria refletir na hora', async () => {
    const post = await chamar('POST', '/v1/me/simulation', U.master, { groupId: groupVivoId });
    expect(post.status).toBe(201);

    // Mesma precondição isolada do caso (b): warm por `invalidar()`, não por depender do
    // start propagar sozinho.
    app.invalidar([U.master]);
    const dentro = await chamar('GET', '/v1/me/authz', U.master);
    expect(dentro.status).toBe(200);
    expect(dentro.body.permissions).toEqual(['worker:read']);

    // Encerra POR SQL DIRETO — nunca via `DELETE /v1/me/simulation` nem `iam.end_group_simulation`.
    // Nenhum evento é publicado por este caminho (o publisher só roda dentro dos use cases da
    // rota); o comportamento DESEJADO é o mesmo do caso (b) mesmo assim — o banco é a fonte da
    // verdade, e a próxima leitura deveria refletir o estado real dele, não um snapshot velho.
    const upd = await pool.query(
      `UPDATE iam.group_simulations SET ended_at = now(), ended_reason = 'USER' WHERE user_id = $1 AND ended_at IS NULL`,
      [U.master],
    );
    expect(upd.rowCount).toBe(1); // premissa: a simulação plantada pelo POST estava mesmo aberta

    const depois = await chamar('GET', '/v1/me/authz', U.master);
    expect(depois.status).toBe(200);
    expect(depois.body.simulation).toBeNull();
    expect(depois.body.permissions).toEqual(masterPermissions);
  });
});
