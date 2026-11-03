/**
 * agent-nao-regressao-078.e2e.test.ts — spec 078, M2 (lote 4, item "nao-regressao"): a porta do agente NÃO tira o conector do ar.
 * Os 3 principais chegam intercalados no MESMO processo, no MESMO `/mcp/v1`, contra Postgres REAL como `app_runtime`/`app_system`:
 *   - principal LEGADO `claude-code` (Bearer estático; o cofre de segredos é a única costura trocada por um dublê);
 *   - principal OAUTH do conector claude.ai (JWT real assinado pelo OAuthTokenService; verificador real montado por `mountOAuthRoutes`);
 *   - o AGENTE (ID token de SA no header próprio).
 * Prova de contexto SEM sonda: o MESMO prestador tem uma vaga de paciente BR. Em contexto de SISTEMA (legado e OAuth) a cidade BR aparece; como ATOR
 * (agente AR) a RLS esconde (city ausente). Dados sintéticos, prefixo `agn078`.
 */
import type { Express } from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { Pool } from 'pg';
import { AGENT_AUDIENCE, AGENT_IDENTITY_HEADER } from '../../src/modules/mcp/domain/AgentCapabilityCells';
import { OAuthTokenService } from '../../src/modules/mcp/application/oauth/OAuthTokenService';
import { ServicePrincipal } from '../../src/modules/mcp/domain/ServicePrincipal';
import { ensureLoginRole, dropLoginRoles, urlFor } from './helpers/loginRoles';

const ADMIN_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const TENANT = '00000000-0000-0000-0000-000000000001';
const PW = 'agn078_pw';
const RT = 'agn078_rt';
const SYS = 'agn078_sys';
const UID = 'agent:agn078';
const EMAIL = 'agn078-sa@enlite-e2e.iam.gserviceaccount.com';
const GRUPO = 'AGN078 espelho';
const P = 'agn078';
const PAC_AR = 'ee078200-0000-4000-8000-0000000000a1';
const PAC_BR = 'ee078200-0000-4000-8000-0000000000b1';
const PA_AR = 'ee078200-0000-4000-8000-0000000000a2';
const PA_BR = 'ee078200-0000-4000-8000-0000000000b2';
const JP_AR = 'ee078200-0000-4000-8000-0000000000a3';
const JP_BR = 'ee078200-0000-4000-8000-0000000000b3';
const ISSUER = 'https://mcp-e2e.enlite.test';
const SIGNING_KEY = 'k'.repeat(64);

/** Cofre de segredos trocado por um dublê (única costura trocada): só o Bearer estático do `claude-code` resolve. */
const cofreFake = {
  async findByToken(token: string): Promise<ServicePrincipal | null> {
    return token === 'legado-claude-code-e2e'
      ? new ServicePrincipal({ name: 'claude-code', allowedCapabilities: ['worker.vacancies.list', 'worker.profile.get'], tokenHashes: ['x'] })
      : null;
  },
};

const tokAgente = (): string => `Bearer mock_${Buffer.from(JSON.stringify({ email: EMAIL, email_verified: true, aud: AGENT_AUDIENCE })).toString('base64')}`;

describe('nao-regressao: principal legado (claude-code), principal OAuth (claude.ai) e agente no mesmo /mcp, intercalados (spec 078, M2)', () => {
  let admin: Pool;
  let url: string;
  let workerId: string;
  let oauthToken: string;
  const servers: Server[] = [];
  const envAnterior: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string | undefined): void => {
    if (!(k in envAnterior)) envAnterior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };

  async function chamar(headers: Record<string, string>, tool = 'worker.vacancies.list') {
    const res = await fetch(`${url}/mcp/v1`, {
      method: 'POST',
      headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: { workerId } } }),
    });
    const body = (await res.json().catch(() => ({}))) as { result?: { isError?: boolean; content?: Array<{ text: string }> } };
    const texto = body.result?.content?.[0]?.text ?? '';
    let json: Record<string, any> = {};
    try { json = JSON.parse(texto); } catch { /* livre */ }
    return { status: res.status, isError: body.result?.isError === true, json, texto };
  }
  const L = (): Record<string, string> => ({ Authorization: 'Bearer legado-claude-code-e2e' });
  const O = (): Record<string, string> => ({ Authorization: `Bearer ${oauthToken}` });
  const A = (): Record<string, string> => ({ [AGENT_IDENTITY_HEADER]: tokAgente(), 'x-enlite-gatilho-id': 'msg-agn-1', 'x-enlite-registro-versao': 'abc123abc123' });
  const cidades = (j: Record<string, any>): { ar?: string; br?: string } => ({
    ar: j.vacancies?.find((v: Record<string, any>) => v.id === JP_AR)?.city,
    br: j.vacancies?.find((v: Record<string, any>) => v.id === JP_BR)?.city,
  });

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await ensureLoginRole(admin, RT, PW, 'app_runtime');
    await ensureLoginRole(admin, SYS, PW, 'app_system');
    setEnv('DATABASE_URL', urlFor(ADMIN_URL, RT, PW));
    setEnv('DATABASE_SYSTEM_URL', urlFor(ADMIN_URL, SYS, PW));
    for (const [k, v] of Object.entries({
      COUNTRY_RLS_ENABLED: 'true', USE_MOCK_AUTH: 'true', GCP_PROJECT_ID: 'enlite-e2e', PERMISSION_ENGINE_ENABLED: 'true', PERMISSION_CATALOG_SYNC_ENABLED: 'true',
      PERMISSION_CACHE_TTL_MS: '0', MCP_OAUTH_ENABLED: 'true', MCP_OAUTH_ISSUER_URL: ISSUER, MCP_OAUTH_SIGNING_KEY: SIGNING_KEY, FIREBASE_WEB_API_KEY: 'fake', FIREBASE_WEB_AUTH_DOMAIN: 'fake.firebaseapp.com',
    })) setEnv(k, v);
    setEnv('MCP_DB_RO_USER', undefined);

    await limpar();
    await admin.query(`INSERT INTO users (firebase_uid, email, display_name, role, account_type, status, is_active, tenant_id) VALUES ($1, $2, 'AGN078', 'support', 'agent', 'ACTIVE', true, $3)`, [UID, EMAIL, TENANT]);
    const gid = (await admin.query(`INSERT INTO iam.permission_groups (tenant_id, name, description, actor_class) VALUES ($1, $2, 'e2e', 'AGENT') RETURNING id`, [TENANT, GRUPO])).rows[0].id;
    const r = await admin.query(`INSERT INTO iam.group_permissions (group_id, permission_id) SELECT $1, id FROM iam.permissions WHERE resource = 'vacancy' AND action = 'read' AND deprecated_at IS NULL RETURNING 1`, [gid]);
    if (r.rowCount !== 1) throw new Error('vacancy:read ausente do catálogo');
    await admin.query(`INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason) VALUES ($1, 'AR', 'e2e', 'e2e')`, [gid]);
    await admin.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [UID, gid, TENANT]);
    workerId = (await admin.query(`INSERT INTO workers (auth_uid, email, status, country) VALUES ($1, $2, 'REGISTERED', 'AR') RETURNING id`, [`${P}-w`, `${P}-w@e2e.local`])).rows[0].id;
    await admin.query(`INSERT INTO patients (id, clickup_task_id, first_name, last_name, country) VALUES ($1, '${P}-ar', 'Pac', 'Arg', 'AR'), ($2, '${P}-br', 'Pac', 'Bra', 'BR')`, [PAC_AR, PAC_BR]);
    await admin.query(`INSERT INTO patient_addresses (id, patient_id, country, city) VALUES ($1, $3, 'AR', 'Palermo'), ($2, $4, 'BR', 'Sao Paulo')`, [PA_AR, PA_BR, PAC_AR, PAC_BR]);
    for (const [id, tit, pat, pa, cn] of [[JP_AR, `${P} vaga AR`, PAC_AR, PA_AR, 78101], [JP_BR, `${P} vaga BR`, PAC_BR, PA_BR, 78102]] as Array<[string, string, string, string, number]>) {
      await admin.query(`INSERT INTO job_postings (id, title, is_draft, status, patient_id, patient_address_id, case_number) VALUES ($1, $2, false, 'SEARCHING', $3, $4, $5)`, [id, tit, pat, pa, cn]);
    }
    await admin.query(`INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage) VALUES ($1, $2, 'INVITED'), ($1, $3, 'INVITED')`, [workerId, JP_AR, JP_BR]);

    oauthToken = new OAuthTokenService(SIGNING_KEY, ISSUER).signAccess({ clientId: 'e2e-client', email: 'ana@enlite.health', role: 'recruiter', scope: 'worker:read' });

    const express = (await import('express')).default;
    const { correlationMiddleware } = await import('@shared/logging/correlationMiddleware');
    const { dbSessionMiddleware } = await import('@shared/database/dbSessionMiddleware');
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    const { mountMcpRoutes } = await import('../../src/modules/mcp/bootstrap/mountMcpRoutes');
    const app: Express = express();
    app.use(express.json());
    app.use(correlationMiddleware);
    app.use(dbSessionMiddleware);
    mountMcpRoutes(app, DatabaseConnection.getInstance().getPool(), { principalRepo: cofreFake });
    const srv = app.listen(0);
    await new Promise<void>((r) => srv.once('listening', () => r()));
    servers.push(srv);
    url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  }, 90000);

  async function limpar(): Promise<void> {
    const w = `(SELECT id FROM workers WHERE auth_uid LIKE '${P}-%')`;
    await admin.query(`DELETE FROM iam.permission_audit_log WHERE user_id = $1`, [UID]);
    await admin.query(`DELETE FROM encuadres WHERE worker_id IN ${w}`);
    await admin.query(`DELETE FROM worker_job_applications WHERE worker_id IN ${w}`);
    await admin.query(`DELETE FROM job_postings WHERE id = ANY($1)`, [[JP_AR, JP_BR]]);
    await admin.query(`DELETE FROM patient_addresses WHERE id = ANY($1)`, [[PA_AR, PA_BR]]);
    await admin.query(`DELETE FROM patients WHERE id = ANY($1)`, [[PAC_AR, PAC_BR]]);
    await admin.query(`DELETE FROM iam.user_groups WHERE user_id = $1`, [UID]);
    await admin.query(`DELETE FROM iam.group_permissions WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name = $1)`, [GRUPO]);
    await admin.query(`DELETE FROM iam.group_country_scopes WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name = $1)`, [GRUPO]);
    await admin.query(`DELETE FROM iam.permission_group_changes WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name = $1)`, [GRUPO]);
    await admin.query(`DELETE FROM iam.permission_groups WHERE name = $1`, [GRUPO]);
    await admin.query(`DELETE FROM users WHERE firebase_uid = $1`, [UID]);
    await admin.query(`DELETE FROM workers WHERE auth_uid LIKE '${P}-%'`);
  }

  afterAll(async () => {
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await limpar().catch((e) => console.error('limpeza', e));
    await dropLoginRoles(admin, [RT, SYS]).catch(() => undefined);
    await admin.end();
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('roles declaradas: app_runtime e app_system sem bypass de RLS', async () => {
    const r = await admin.query(`SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname`, [[RT, SYS]]);
    expect(r.rows).toEqual([{ rolname: RT, rolbypassrls: false }, { rolname: SYS, rolbypassrls: false }]);
  });

  it('principal LEGADO (claude-code): resolve e roda em contexto de SISTEMA — a vaga do paciente BR aparece COM cidade', async () => {
    const r = await chamar(L());
    expect([r.status, r.isError]).toEqual([200, false]);
    expect(cidades(r.json)).toEqual({ ar: 'Palermo', br: 'Sao Paulo' });
  });

  it('principal OAUTH (claude.ai, JWT real, tool com nome sanitizado): resolve e roda em contexto de SISTEMA — cidade BR visível', async () => {
    const r = await chamar(O(), 'worker_vacancies_list');
    expect([r.status, r.isError]).toEqual([200, false]);
    expect(cidades(r.json)).toEqual({ ar: 'Palermo', br: 'Sao Paulo' });
  });

  it('AGENTE (header próprio): roda como ATOR AR — a cidade BR some (RLS); a AR aparece', async () => {
    const r = await chamar(A());
    expect([r.status, r.isError]).toEqual([200, false]);
    expect(cidades(r.json)).toEqual({ ar: 'Palermo', br: undefined });
  });

  it('INTERCALADOS no mesmo processo (A, L, O, A, O, L): os 3 devolvem 200 e cada um mantém o SEU contexto — o agente não quebra os dois, nem o contrário', async () => {
    const seq: Array<[string, () => Record<string, string>, string, { ar?: string; br?: string }]> = [
      ['agente', A, 'worker.vacancies.list', { ar: 'Palermo', br: undefined }],
      ['legado', L, 'worker.vacancies.list', { ar: 'Palermo', br: 'Sao Paulo' }],
      ['oauth', O, 'worker_vacancies_list', { ar: 'Palermo', br: 'Sao Paulo' }],
      ['agente', A, 'worker.vacancies.list', { ar: 'Palermo', br: undefined }],
      ['oauth', O, 'worker_vacancies_list', { ar: 'Palermo', br: 'Sao Paulo' }],
      ['legado', L, 'worker.vacancies.list', { ar: 'Palermo', br: 'Sao Paulo' }],
    ];
    for (const [quem, h, tool, esperado] of seq) {
      const r = await chamar(h(), tool);
      expect([quem, r.status, r.isError]).toEqual([quem, 200, false]);
      expect([quem, cidades(r.json)]).toEqual([quem, esperado]);
    }
  });

  it('o agente NÃO consome o Bearer alheio: legado/OAuth sem o header seguem o caminho de hoje; JWT forjado -> 401 (vai ao verificador OAuth); Bearer legado errado -> 401', async () => {
    const forjado = new OAuthTokenService('z'.repeat(64), ISSUER).signAccess({ clientId: 'x', email: 'x@enlite.health', role: 'recruiter', scope: 'worker:read' });
    expect((await chamar({ Authorization: `Bearer ${forjado}` }, 'worker_vacancies_list')).status).toBe(401);
    expect((await chamar({ Authorization: 'Bearer legado-errado' })).status).toBe(401);
    // header do agente com Bearer legado VÁLIDO junto + identidade inválida: 401 do agente, sem downgrade
    const r = await chamar({ [AGENT_IDENTITY_HEADER]: 'f'.repeat(64), ...L() });
    expect(r.status).toBe(401);
  });

  it('a trilha do agente só tem linhas do AGENTE: o legado e o OAuth não geram `actor_kind=agente` (controle: o agente gerou ≥ 1)', async () => {
    const l = await admin.query(`SELECT count(*)::int AS n FROM iam.permission_audit_log WHERE user_id = $1 AND actor_kind = 'agente'`, [UID]);
    expect(l.rows[0].n).toBeGreaterThanOrEqual(1);
    const fora = await admin.query(`SELECT count(*)::int AS n FROM iam.permission_audit_log WHERE actor_kind = 'agente' AND user_id <> $1 AND created_at > now() - interval '5 minutes'`, [UID]);
    expect(fora.rows[0].n).toBe(0);
  });
});
