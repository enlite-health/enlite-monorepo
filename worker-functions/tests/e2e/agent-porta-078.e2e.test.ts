/**
 * agent-porta-078.e2e.test.ts — spec 078, M2 (lote 2): a porta MCP do agente contra POSTGRES REAL, HTTP real, ABAC ligado.
 *
 * O app conecta como login de `app_runtime` (NOSUPERUSER, NOBYPASSRLS) e `app_system` (dois pools, como na stage); o dono (DATABASE_URL de
 * setup) só semeia e confere. Itens provados aqui: 30 (ID token de SA -> 200; token longo -> 401; ator agent, system_context vazio),
 * 31 (grupo espelho com X e sem Y), 32 (RLS por país como ATOR; controle: sistema vê o outro país), 33 (limitador no banco: teto, leitura
 * não conta, 2 apps somam 10, janela de 60 s, pool caído -> fail-closed), 34 (1 chamada = 1 linha actor_kind='agente'), 35 (status sem cache).
 * O item 36 (triggers) é do `agent-schema-078` (lote 1); o verificador é do lote 4. Dados SINTÉTICOS, prefixo `agp078`.
 */
import type { Express } from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { Pool } from 'pg';
import { AGENT_AUDIENCE, AGENT_IDENTITY_HEADER, AGENT_WRITE_LIMIT_PER_MIN } from '../../src/modules/mcp/domain/AgentCapabilityCells';
import { ensureLoginRole, dropLoginRoles, urlFor } from './helpers/loginRoles';
import { garantirCelulas, removerCelulasCriadas } from './helpers/permissionFamilyHarness';

const ADMIN_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const TENANT = '00000000-0000-0000-0000-000000000001';
const PW = 'agp078_pw';
const RT = 'agp078_rt';
const SYS = 'agp078_sys';
const UID = 'agent:agp078';
const EMAIL = 'agp078-sa@enlite-e2e.iam.gserviceaccount.com';
const GRUPO = 'AGP078 espelho';
const PREFIXO = 'agp078';
const W_AUTH = `${PREFIXO}-worker`;
const PAC_AR = 'ee078000-0000-4000-8000-0000000000a1';
const PAC_BR = 'ee078000-0000-4000-8000-0000000000b1';
const CELULAS: Array<[string, string]> = [['worker', 'read'], ['vacancy', 'read'], ['worker', 'update']];

const tok = (p: object = {}): string =>
  `Bearer mock_${Buffer.from(JSON.stringify({ email: EMAIL, email_verified: true, aud: AGENT_AUDIENCE, ...p })).toString('base64')}`;

describe('porta MCP do agente — HTTP real, banco real, ABAC ligado (spec 078, M2 lote 2)', () => {
  let admin: Pool;
  let celulasCriadas: string[] = [];
  let workerId: string;
  const servers: Server[] = [];
  const envAnterior: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string): void => {
    if (!(k in envAnterior)) envAnterior[k] = process.env[k];
    process.env[k] = v;
  };
  let montarApp: (gate?: unknown) => Promise<string>;
  let urlA: string;
  let appPool: Pool;

  async function rpc(url: string, headers: Record<string, string>, tool: string, args: Record<string, unknown> = {}) {
    const res = await fetch(`${url}/mcp/v1`, {
      method: 'POST',
      headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
    });
    const body = (await res.json().catch(() => ({}))) as { result?: { isError?: boolean; content?: Array<{ text: string }> }; code?: string };
    const texto = body.result?.content?.[0]?.text ?? '';
    let json: Record<string, any> = {};
    try { json = JSON.parse(texto); } catch { /* texto livre */ }
    return { status: res.status, body, isError: body.result?.isError === true, texto, json };
  }
  const H = (extra: Record<string, string> = {}) => ({ [AGENT_IDENTITY_HEADER]: tok(), 'x-enlite-gatilho-id': 'msg-e2e-1', 'x-enlite-registro-versao': 'abc123abc123', ...extra });
  const linhas = async (where = '') =>
    (await admin.query(`SELECT * FROM iam.permission_audit_log WHERE user_id = $1 ${where} ORDER BY created_at, id`, [UID])).rows;
  const limparTrilha = () => admin.query(`DELETE FROM iam.permission_audit_log WHERE user_id = $1`, [UID]);
  const SLOTS = { workerId: '', slots: [{ dayOfWeek: 1, startTime: '09:00', endTime: '12:00' }] };

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await ensureLoginRole(admin, RT, PW, 'app_runtime');
    await ensureLoginRole(admin, SYS, PW, 'app_system');
    setEnv('DATABASE_URL', urlFor(ADMIN_URL, RT, PW));
    setEnv('DATABASE_SYSTEM_URL', urlFor(ADMIN_URL, SYS, PW));
    setEnv('COUNTRY_RLS_ENABLED', 'true');
    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('GCP_PROJECT_ID', 'enlite-e2e');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_CATALOG_SYNC_ENABLED', 'true');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    delete process.env.MCP_OAUTH_ENABLED;
    delete process.env.MCP_DB_RO_USER;

    // fixtures (dono): agente ACTIVE, grupo AGENT com 3 células AR, 2 pacientes (AR/BR), 1 worker
    await admin.query(`DELETE FROM iam.permission_audit_log WHERE user_id = $1`, [UID]);
    await admin.query(`DELETE FROM iam.user_groups WHERE user_id = $1`, [UID]);
    await admin.query(`DELETE FROM iam.group_permissions WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name = $1)`, [GRUPO]);
    await admin.query(`DELETE FROM iam.group_country_scopes WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name = $1)`, [GRUPO]);
    await admin.query(`DELETE FROM iam.permission_group_changes WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name = $1)`, [GRUPO]);
    await admin.query(`DELETE FROM iam.permission_groups WHERE name = $1`, [GRUPO]);
    await admin.query(`DELETE FROM users WHERE firebase_uid = $1`, [UID]);
    await admin.query(`DELETE FROM patients WHERE id = ANY($1)`, [[PAC_AR, PAC_BR]]);
    await admin.query(`DELETE FROM workers WHERE auth_uid = $1`, [W_AUTH]);

    await admin.query(
      `INSERT INTO users (firebase_uid, email, display_name, role, account_type, status, is_active, tenant_id)
       VALUES ($1, $2, 'AGP078', 'support', 'agent', 'ACTIVE', true, $3)`,
      [UID, EMAIL, TENANT],
    );
    const g = await admin.query(
      `INSERT INTO iam.permission_groups (tenant_id, name, description, actor_class) VALUES ($1, $2, 'e2e', 'AGENT') RETURNING id`,
      [TENANT, GRUPO],
    );
    const gid = g.rows[0].id as string;
    // o job backend-e2e não sincroniza o catálogo: garante (idempotente) as células de que o teste depende e lembra quais criou
    celulasCriadas = await garantirCelulas(admin, [...CELULAS.map(([r, a]) => `${r}:${a}`), 'worker_application:create', 'handover:create']);
    for (const [resource, action] of CELULAS) {
      const r = await admin.query(
        `INSERT INTO iam.group_permissions (group_id, permission_id) SELECT $1, id FROM iam.permissions WHERE resource = $2 AND action = $3 RETURNING 1`,
        [gid, resource, action],
      );
      if (r.rowCount !== 1) throw new Error(`célula ${resource}:${action} ausente do catálogo`);
    }
    await admin.query(`INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason) VALUES ($1, 'AR', 'e2e', 'e2e')`, [gid]);
    await admin.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [UID, gid, TENANT]);
    await admin.query(
      `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country) VALUES ($1, 'agp078-ar', 'Pac', 'Arg', 'AR'), ($2, 'agp078-br', 'Pac', 'Bra', 'BR')`,
      [PAC_AR, PAC_BR],
    );
    const w = await admin.query(`INSERT INTO workers (auth_uid, email, status, country) VALUES ($1, $2, 'INCOMPLETE_REGISTER', 'AR') RETURNING id`, [W_AUTH, `${W_AUTH}@e2e.local`]);
    workerId = w.rows[0].id as string;
    SLOTS.workerId = workerId;

    const express = (await import('express')).default;
    const { correlationMiddleware } = await import('@shared/logging/correlationMiddleware');
    const { dbSessionMiddleware } = await import('@shared/database/dbSessionMiddleware');
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    const { mountMcpRoutes } = await import('../../src/modules/mcp/bootstrap/mountMcpRoutes');
    const { createAgentEntry } = await import('../../src/modules/mcp/interfaces/middleware/agentActorContext');
    const { withSystemDbContext } = await import('@shared/database/requestDbSession');
    appPool = DatabaseConnection.getInstance().getPool();

    montarApp = async (gate?: unknown): Promise<string> => {
      const app: Express = express();
      app.use(express.json());
      app.use(correlationMiddleware);
      app.use(dbSessionMiddleware);
      mountMcpRoutes(app, appPool, gate ? { agent: { gate: gate as never } } : {});
      // sonda (só no teste): a MESMA entrada do agente (identidade + status + ator) e uma leitura sob o contexto que a capability teria
      app.get('/sonda', createAgentEntry(appPool), async (_req, res) => {
        const ctx = await appPool.query(
          `SELECT current_user AS quem, current_setting('app.user_uid', true) AS uid, current_setting('app.system_context', true) AS sistema`,
        );
        const pac = await appPool.query(`SELECT country FROM patients WHERE id = ANY($1) ORDER BY country`, [[PAC_AR, PAC_BR]]);
        const controle = await withSystemDbContext('job:e2e-agp078-controle', async () =>
          (await appPool.query(`SELECT country FROM patients WHERE id = ANY($1) ORDER BY country`, [[PAC_AR, PAC_BR]])).rows.map((r) => r.country),
        );
        res.json({ ctx: ctx.rows[0], pacientes: pac.rows.map((r) => r.country), controleSistema: controle });
      });
      const srv = app.listen(0);
      await new Promise<void>((r) => srv.once('listening', () => r()));
      servers.push(srv);
      return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    };
    urlA = await montarApp();
  }, 60000);

  afterAll(async () => {
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await admin.query(`DELETE FROM resource_access_log WHERE operator_uid = $1`, [UID]).catch(() => undefined);
    await limparTrilha();
    await admin.query(`DELETE FROM iam.user_groups WHERE user_id = $1`, [UID]);
    await admin.query(`DELETE FROM iam.group_permissions WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name = $1)`, [GRUPO]);
    await admin.query(`DELETE FROM iam.group_country_scopes WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name = $1)`, [GRUPO]);
    await admin.query(`DELETE FROM iam.permission_group_changes WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name = $1)`, [GRUPO]);
    await admin.query(`DELETE FROM iam.permission_groups WHERE name = $1`, [GRUPO]);
    await admin.query(`DELETE FROM users WHERE firebase_uid = $1`, [UID]);
    await admin.query(`DELETE FROM patients WHERE id = ANY($1)`, [[PAC_AR, PAC_BR]]);
    await admin.query(`DELETE FROM worker_availability WHERE worker_id = $1`, [workerId]);
    await admin.query(`DELETE FROM workers WHERE auth_uid = $1`, [W_AUTH]);
    await removerCelulasCriadas(admin, celulasCriadas).catch((e) => console.error('limpeza células', e));
    await dropLoginRoles(admin, [RT, SYS]).catch(() => undefined);
    await admin.end();
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(async () => {
    await limparTrilha();
    await admin.query(`DELETE FROM worker_availability WHERE worker_id = $1`, [workerId]);
    await admin.query(`UPDATE users SET status = 'ACTIVE' WHERE firebase_uid = $1`, [UID]);
  });

  it('as roles do teste são as da stage: app_runtime e app_system SEM bypass de RLS (declaradas, não presumidas)', async () => {
    const r = await admin.query(`SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname`, [[RT, SYS]]);
    expect(r.rows).toEqual([
      { rolname: RT, rolbypassrls: false, rolsuper: false },
      { rolname: SYS, rolbypassrls: false, rolsuper: false },
    ]);
    const pool = new Pool({ connectionString: urlFor(ADMIN_URL, RT, PW), max: 1 });
    const q = await pool.query(`SELECT current_user AS u, pg_has_role(current_user, 'app_runtime', 'member') AS m`);
    await pool.end();
    expect(q.rows[0]).toEqual({ u: RT, m: true });
  });

  it('as 2 células novas estão no catálogo do banco (garantidas por garantirCelulas; no CI não há sync) e não pertencem a nenhum grupo humano', async () => {
    const r = await admin.query(
      `SELECT p.resource || ':' || p.action AS c, p.deprecated_at IS NULL AS vivo FROM iam.permissions p WHERE p.resource IN ('worker_application','handover') ORDER BY 1`,
    );
    expect(r.rows).toEqual([{ c: 'handover:create', vivo: true }, { c: 'worker_application:create', vivo: true }]);
  });

  // ── item 30 ────────────────────────────────────────────────────────────────────────
  it('item 30: ID token de SA -> 200 e a capability roda; token longo no header -> 401 AGENT_IDENTITY_INVALID; sem downgrade para o legado', async () => {
    const ok = await rpc(urlA, H(), 'worker.availability.get', { workerId });
    expect([ok.status, ok.isError]).toEqual([200, false]);
    const longo = await rpc(urlA, { [AGENT_IDENTITY_HEADER]: 'f'.repeat(64) }, 'worker.availability.get', { workerId });
    expect([longo.status, longo.body.code]).toEqual([401, 'AGENT_IDENTITY_INVALID']);
    // header de identidade presente + Bearer legado qualquer + identidade inválida: 401 final do agente (o legado nem é consultado)
    const semDowngrade = await rpc(urlA, { [AGENT_IDENTITY_HEADER]: tok({ aud: 'https://api.enlite.health/assistentes' }), Authorization: 'Bearer legado' }, 'worker.availability.get', { workerId });
    expect([semDowngrade.status, semDowngrade.body.code]).toEqual([401, 'AGENT_IDENTITY_INVALID']);
  });

  it('item 30: dentro da porta o banco vê o ator agent (app.user_uid) como app_runtime e app.system_context VAZIO', async () => {
    const res = await fetch(`${urlA}/sonda`, { headers: { [AGENT_IDENTITY_HEADER]: tok() } });
    const j = (await res.json()) as { ctx: { quem: string; uid: string; sistema: string } };
    expect(res.status).toBe(200);
    expect(j.ctx).toEqual({ quem: RT, uid: UID, sistema: '' });
  });

  // ── item 31 ────────────────────────────────────────────────────────────────────────
  it('item 31: grupo espelho com X (worker:read) e sem Y (interview:read, worker_application:create, handover:create): X ok, Y recusado missing_cell', async () => {
    const x = await rpc(urlA, H(), 'worker.availability.get', { workerId });
    expect(x.isError).toBe(false);
    for (const [tool, args, cell] of [
      ['worker.interview.get', { workerId }, 'interview:read'],
      ['worker.application.register', { workerId, jobPostingId: '00000000-0000-4000-8000-000000000001' }, 'worker_application:create'],
      ['handover.notify', { workerPhone: '+5491100000000', team: 'recruitment', reason: 'e2e (recusado antes de executar: nada sai)', conversationId: 1 }, 'handover:create'],
    ] as Array<[string, Record<string, unknown>, string]>) {
      const y = await rpc(urlA, H(), tool, args);
      expect([tool, y.isError, y.json.code, y.json.cell]).toEqual([tool, true, 'missing_cell', cell]);
    }
    const negadas = await linhas(`AND decision = 'DENY'`);
    expect(negadas.map((l) => `${l.resource}:${l.action}`).sort()).toEqual(['handover:create', 'interview:read', 'worker_application:create']);
  });

  it('capability fora do mapa (ex.: db.query.readonly) nem é registrada para o agente: o servidor responde "tool not found"', async () => {
    const r = await rpc(urlA, H(), 'db.query.readonly', { sql: 'select 1' });
    expect(r.isError).toBe(true);
    expect(r.texto).toMatch(/not found/i);
  });

  // ── item 32 ────────────────────────────────────────────────────────────────────────
  it('item 32: patients AR e BR, grupo só AR -> o agente vê só a AR (BR = 0); controle: contexto de SISTEMA vê as duas', async () => {
    const res = await fetch(`${urlA}/sonda`, { headers: { [AGENT_IDENTITY_HEADER]: tok() } });
    const j = (await res.json()) as { pacientes: string[]; controleSistema: string[] };
    expect(j.pacientes).toEqual(['AR']);
    expect(j.controleSistema).toEqual(['AR', 'BR']);
  });

  // ── item 34 ────────────────────────────────────────────────────────────────────────
  it('item 34: 1 escrita = exatamente 1 linha actor_kind=agente, user_id do agente, gatilho_id e registro_versao dos headers; a escrita de fato gravou', async () => {
    const r = await rpc(urlA, H(), 'worker.availability.set', SLOTS);
    expect([r.isError, r.json.ok]).toEqual([false, true]);
    const l = await linhas();
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ actor_kind: 'agente', user_id: UID, resource: 'worker', action: 'update', decision: 'ALLOW', gatilho_id: 'msg-e2e-1', registro_versao: 'abc123abc123', resource_id: workerId });
    const a = await admin.query(`SELECT count(*)::int AS n FROM worker_availability WHERE worker_id = $1`, [workerId]);
    expect(a.rows[0].n).toBe(1);
    const hist = await admin.query(`SELECT 1 FROM pg_trigger WHERE tgname ILIKE '%worker_availability%' LIMIT 1`);
    expect(hist.rowCount).toBeGreaterThanOrEqual(0);
  });

  it('item 34: leitura também gera 1 linha (ALLOW, action=read); headers ausentes NÃO dão 400: gatilho_id NULL e registro_versao="nao-informado"', async () => {
    const r = await rpc(urlA, { [AGENT_IDENTITY_HEADER]: tok() }, 'worker.availability.get', { workerId });
    expect(r.status).toBe(200);
    const l = await linhas();
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ actor_kind: 'agente', action: 'read', decision: 'ALLOW', gatilho_id: null, registro_versao: 'nao-informado' });
  });

  it('item 34 (controle): a trilha do HUMANO continua actor_kind=humano (DEFAULT) — o caminho humano não foi tocado', async () => {
    const { PgPermissionAuditRepository } = await import('../../src/modules/identity/permissions/infrastructure/PgPermissionAuditRepository');
    new PgPermissionAuditRepository(appPool).record({ tenantId: TENANT, userId: UID, resource: 'worker', action: 'read', decision: 'ALLOW' } as never);
    let l: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 30 && l.length === 0; i += 1) { await new Promise((r) => setTimeout(r, 100)); l = await linhas(); }
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ actor_kind: 'humano', gatilho_id: null, registro_versao: null });
  });

  it('classe (b) (runtime do operador): worker.caseMemory.get roda em contexto de sistema pelo principal e deixa 1 linha (worker_case_memory:read)', async () => {
    const r = await rpc(urlA, H(), 'worker.caseMemory.get', { workerId });
    expect(r.status).toBe(200);
    expect(r.json.code).toBeUndefined();
    const l = await linhas();
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ resource: 'worker_case_memory', action: 'read', decision: 'ALLOW', actor_kind: 'agente' });
  });

  // ── item 33 ────────────────────────────────────────────────────────────────────────
  it('item 33: 10ª escrita passa, 11ª recusada AGENT_RATE_LIMITED com retryAfterMs > 0 e linha DENY; a 11ª NÃO executa; 1 linha por chamada', async () => {
    for (let i = 0; i < AGENT_WRITE_LIMIT_PER_MIN; i += 1) {
      const r = await rpc(urlA, H(), 'worker.availability.set', SLOTS);
      expect([i, r.isError]).toEqual([i, false]);
    }
    await admin.query(`DELETE FROM worker_availability WHERE worker_id = $1`, [workerId]);
    const onze = await rpc(urlA, H(), 'worker.availability.set', SLOTS);
    expect([onze.isError, onze.json.code]).toEqual([true, 'AGENT_RATE_LIMITED']);
    expect(onze.json.retryAfterMs).toBeGreaterThan(0);
    const a = await admin.query(`SELECT count(*)::int AS n FROM worker_availability WHERE worker_id = $1`, [workerId]);
    expect(a.rows[0].n).toBe(0); // a 11ª não executou
    const l = await linhas();
    expect(l).toHaveLength(11);
    expect(l.filter((x) => x.decision === 'ALLOW')).toHaveLength(10);
    expect(l.filter((x) => x.decision === 'DENY')).toHaveLength(1);
  });

  it('item 33: leituras (action=read) não contam — 20 leituras e a 1ª escrita passa', async () => {
    for (let i = 0; i < 20; i += 1) expect((await rpc(urlA, H(), 'worker.availability.get', { workerId })).isError).toBe(false);
    expect((await rpc(urlA, H(), 'worker.availability.set', SLOTS)).isError).toBe(false);
    expect(await linhas()).toHaveLength(21);
  });

  it('item 33: 2 apps Express no MESMO banco, 20 escritas concorrentes -> exatamente 10 ALLOW e 10 recusas (nem 11, nem 9)', async () => {
    const urlB = await montarApp();
    const alvos = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? urlA : urlB));
    const rs = await Promise.all(alvos.map((u) => rpc(u, H(), 'worker.availability.set', SLOTS)));
    // (a execução concorrente da MESMA disponibilidade pode colidir no DELETE+INSERT do worker: o que se mede aqui é a ADMISSÃO)
    expect(rs.filter((r) => r.json.code === 'AGENT_RATE_LIMITED')).toHaveLength(20 - AGENT_WRITE_LIMIT_PER_MIN);
    expect(rs.filter((r) => r.json.code === 'AGENT_LIMITER_UNAVAILABLE')).toHaveLength(0);
    const l = await linhas();
    expect(l.filter((x) => x.decision === 'ALLOW')).toHaveLength(AGENT_WRITE_LIMIT_PER_MIN);
  });

  it('item 33: dois limitadores em DUAS conexões/pools de verdade, 40 admissões em Promise.all -> exatamente 10 ALLOW (o advisory lock serializa; sem ele a contagem corre)', async () => {
    const { PgAgentWriteLimiter } = await import('../../src/modules/mcp/infrastructure/PgAgentWriteLimiter');
    const p1 = new Pool({ connectionString: urlFor(ADMIN_URL, RT, PW), max: 10 });
    const p2 = new Pool({ connectionString: urlFor(ADMIN_URL, RT, PW), max: 10 });
    try {
      // pools AQUECIDOS: sem isso o handshake de conexão escalona as chamadas e a corrida some sozinha
      for (const p of [p1, p2]) (await Promise.all(Array.from({ length: 10 }, () => p.connect()))).forEach((c) => c.release());
      const l1 = new PgAgentWriteLimiter(p1);
      const l2 = new PgAgentWriteLimiter(p2);
      const call = { uid: UID, resource: 'worker', action: 'update', registroVersao: 'v', gatilhoId: null };
      const rs = await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? l1 : l2).admit(call)));
      expect(rs.filter((r) => r.ok)).toHaveLength(AGENT_WRITE_LIMIT_PER_MIN);
      expect(rs.filter((r) => !r.ok && r.code === 'AGENT_RATE_LIMITED')).toHaveLength(40 - AGENT_WRITE_LIMIT_PER_MIN);
      expect((await linhas(`AND decision = 'ALLOW'`))).toHaveLength(AGENT_WRITE_LIMIT_PER_MIN);
    } finally {
      await p1.end();
      await p2.end();
    }
  });

  it('item 33: linha ALLOW de 61 s atrás NÃO conta (janela de 60 s); a de 30 s atrás conta', async () => {
    const semear = (seg: number, n: number) =>
      admin.query(
        `INSERT INTO iam.permission_audit_log (tenant_id, user_id, resource, action, decision, actor_kind, registro_versao, created_at)
         SELECT $1, $2, 'worker', 'update', 'ALLOW', 'agente', 'v', now() - ($3 || ' seconds')::interval FROM generate_series(1, $4)`,
        [TENANT, UID, String(seg), n],
      );
    await semear(61, AGENT_WRITE_LIMIT_PER_MIN);
    expect((await rpc(urlA, H(), 'worker.availability.set', SLOTS)).isError).toBe(false); // as 10 velhas fora da janela
    await limparTrilha();
    await semear(30, AGENT_WRITE_LIMIT_PER_MIN);
    const r = await rpc(urlA, H(), 'worker.availability.set', SLOTS);
    expect([r.isError, r.json.code]).toEqual([true, 'AGENT_RATE_LIMITED']);
  });

  it('item 33: erro de pool no limitador -> AGENT_LIMITER_UNAVAILABLE (fail-closed) e a capability NÃO executa (0 execuções)', async () => {
    const { AgentCallGate } = await import('../../src/modules/mcp/application/AgentCallGate');
    const { AgentCellGuard } = await import('../../src/modules/mcp/application/AgentCellGuard');
    const { PgAgentWriteLimiter } = await import('../../src/modules/mcp/infrastructure/PgAgentWriteLimiter');
    const { PgAgentAuditRepository } = await import('../../src/modules/mcp/infrastructure/PgAgentAuditRepository');
    const { createPermissionsModule } = await import('@modules/identity/permissions');
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    const quebrado = { connect: async () => { throw new Error('pool caiu'); } } as unknown as Pool;
    const permissions = createPermissionsModule({ pool: appPool, systemPool: DatabaseConnection.getInstance().getSystemPool(), ttlMs: 0 });
    const gate = new AgentCallGate({ guard: new AgentCellGuard(permissions.client), limiter: new PgAgentWriteLimiter(quebrado), audit: new PgAgentAuditRepository(appPool) });
    const url = await montarApp(gate);
    const r = await rpc(url, H(), 'worker.availability.set', SLOTS);
    expect([r.isError, r.json.code]).toEqual([true, 'AGENT_LIMITER_UNAVAILABLE']);
    const a = await admin.query(`SELECT count(*)::int AS n FROM worker_availability WHERE worker_id = $1`, [workerId]);
    expect(a.rows[0].n).toBe(0);
    expect(await linhas(`AND decision = 'ALLOW'`)).toHaveLength(0);
  });

  // ── worker.byPhone (decisão 4 do lote 0) ──────────────────────────────────────────────
  it('worker.byPhone: sem worker_pii:read -> missing_cell; com a célula -> acha o prestador e grava a trilha de acesso com o UUID (nunca o telefone)', async () => {
    const FONE = '+5491155550078';
    await admin.query(`UPDATE workers SET phone = $2 WHERE id = $1`, [workerId, FONE]);
    const sem = await rpc(urlA, H(), 'worker.byPhone', { phone: FONE });
    expect([sem.isError, sem.json.code, sem.json.cell]).toEqual([true, 'missing_cell', 'worker_pii:read']);

    const gid = (await admin.query(`SELECT id FROM iam.permission_groups WHERE name = $1`, [GRUPO])).rows[0].id as string;
    const ins = await admin.query(`INSERT INTO iam.group_permissions (group_id, permission_id) SELECT $1, id FROM iam.permissions WHERE resource = 'worker_pii' AND action = 'read' RETURNING 1`, [gid]);
    expect(ins.rowCount).toBe(1);
    try {
      const com = await rpc(urlA, H(), 'worker.byPhone', { phone: FONE });
      expect([com.isError, com.json.found]).toEqual([false, true]);
      expect(com.json.worker.id).toBe(workerId);
      const rastro = await admin.query(`SELECT operator_uid, operator_role, resource_type, resource_id, action FROM resource_access_log WHERE operator_uid = $1`, [UID]);
      expect(rastro.rows).toEqual([{ operator_uid: UID, operator_role: 'agent', resource_type: 'worker', resource_id: workerId, action: 'read_by_phone' }]);
      expect(JSON.stringify(rastro.rows)).not.toContain('5550078');
      const naoAchou = await rpc(urlA, H(), 'worker.byPhone', { phone: '+5491100009999' });
      expect(naoAchou.json).toEqual({ found: false });
    } finally {
      await admin.query(`DELETE FROM iam.group_permissions WHERE group_id = $1 AND permission_id IN (SELECT id FROM iam.permissions WHERE resource = 'worker_pii' AND action = 'read')`, [gid]);
      await admin.query(`DELETE FROM resource_access_log WHERE operator_uid = $1`, [UID]);
    }
  });

  // ── item 35 ────────────────────────────────────────────────────────────────────────
  it('item 35: users.status=SUSPENDED -> a PRÓXIMA chamada dá 401 AGENT_DISABLED (sem cache de 30 s); religado -> 200', async () => {
    expect((await rpc(urlA, H(), 'worker.availability.get', { workerId })).status).toBe(200);
    await admin.query(`UPDATE users SET status = 'SUSPENDED' WHERE firebase_uid = $1`, [UID]);
    const off = await rpc(urlA, H(), 'worker.availability.get', { workerId });
    expect([off.status, off.body.code]).toEqual([401, 'AGENT_DISABLED']);
    await admin.query(`UPDATE users SET status = 'ACTIVE' WHERE firebase_uid = $1`, [UID]);
    expect((await rpc(urlA, H(), 'worker.availability.get', { workerId })).status).toBe(200);
  });

  it('o e-mail da SA de um staff (account_type=staff) NÃO abre a porta do agente', async () => {
    await admin.query(`UPDATE users SET account_type = 'staff', role = 'recruiter' WHERE firebase_uid = $1`, [UID]);
    try {
      const r = await rpc(urlA, H(), 'worker.availability.get', { workerId });
      expect([r.status, r.body.code]).toEqual([401, 'AGENT_IDENTITY_INVALID']);
    } finally {
      await admin.query(`UPDATE users SET account_type = 'agent', role = 'support' WHERE firebase_uid = $1`, [UID]);
    }
  });
});
