/**
 * agent-capabilities-078.e2e.test.ts — spec 078, M2 (lote 4): CADA UMA das 15 capabilities da classe (a) da Luz, com `app_runtime` (RLS ligada), ABAC ligado
 * e um grupo AGENT sintético AR com as células do mapa (`AGENT_CAPABILITY_CELLS`):
 *   - COM a célula: devolve DADO (≥ 1 registro / estado alterado; contagem 0 é falha, nunca sucesso);
 *   - SEM a célula: `missing_cell` com a célula certa (e a chamada foi tentada: a trilha DENY existe);
 *   - país: dado de paciente BR fica invisível ao agente AR (RLS) e o contexto de SISTEMA o enxerga (controle positivo).
 * Escritas: 1 linha ALLOW `actor_kind='agente'` por chamada. Nenhum canal real: `handover.notify` roda com `HANDOVER_NOTIFY_ENABLED` ausente (kill-switch OFF =>
 * `skipped:true`, zero chamada ao Periskope; a rede do processo jest ainda é bloqueada por scripts/rede-bloqueada-em-teste.cjs). Dados SINTÉTICOS, prefixo `agc078`.
 */
import * as fs from 'fs';
import type { Express } from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { Pool } from 'pg';
import { AGENT_AUDIENCE, AGENT_CAPABILITY_CELLS, AGENT_CAPABILITY_NAMES, AGENT_IDENTITY_HEADER } from '../../src/modules/mcp/domain/AgentCapabilityCells';
import { ensureLoginRole, dropLoginRoles, urlFor } from './helpers/loginRoles';

const ADMIN_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const EVID = process.env.AGC078_EVID; // opcional: arquivo para as linhas-resumo
const TENANT = '00000000-0000-0000-0000-000000000001';
const PW = 'agc078_pw';
const RT = 'agc078_rt';
const SYS = 'agc078_sys';
const UID = 'agent:agc078';
const EMAIL = 'agc078-sa@enlite-e2e.iam.gserviceaccount.com';
const GRUPO = 'AGC078 espelho';
const GRUPO_HUMANO = 'AGC078 espelho humano';
const P = 'agc078';
const PAC_AR = 'ee078100-0000-4000-8000-0000000000a1';
const PAC_BR = 'ee078100-0000-4000-8000-0000000000b1';
const PA_AR = 'ee078100-0000-4000-8000-0000000000a2';
const PA_BR = 'ee078100-0000-4000-8000-0000000000b2';
const JP_AR = 'ee078100-0000-4000-8000-0000000000a3';
const JP_BR = 'ee078100-0000-4000-8000-0000000000b3';
const JP_NEW = 'ee078100-0000-4000-8000-0000000000c3';
const SLOT = 'ee078100-0000-4000-8000-0000000000a4';
const PHONE = '+5491155578001';

const tok = (): string => `Bearer mock_${Buffer.from(JSON.stringify({ email: EMAIL, email_verified: true, aud: AGENT_AUDIENCE })).toString('base64')}`;
const celulasDoMapa = [...new Set(Object.values(AGENT_CAPABILITY_CELLS))];

type Json = Record<string, any>;
interface Caso {
  tool: string;
  write: boolean;
  /** worker alvo (cada escrita com efeito de estado tem o seu, para o teste não depender de ordem). */
  w: string;
  args: (ids: Ids) => Record<string, unknown>;
  defeito?: RegExp;
  /** devolve a descrição do dado obtido (e falha com expect se não houver dado). */
  dado: (j: Json, ids: Ids) => string;
}
interface Ids { [k: string]: string }

describe('as 15 capabilities da classe (a) com app_runtime, grupo AGENT AR sintético, motor ABAC ligado (spec 078, M2 lote 4)', () => {
  let admin: Pool;
  let appPool: Pool;
  let url: string;
  let gid: string;
  const ids: Ids = {};
  const servers: Server[] = [];
  const envAnterior: Record<string, string | undefined> = {};
  const resumo: string[] = [];
  const setEnv = (k: string, v: string | undefined): void => {
    if (!(k in envAnterior)) envAnterior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };

  async function rpc(tool: string, args: Record<string, unknown>) {
    const res = await fetch(`${url}/mcp/v1`, {
      method: 'POST',
      headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', [AGENT_IDENTITY_HEADER]: tok(), 'x-enlite-gatilho-id': 'msg-agc-1', 'x-enlite-registro-versao': 'abc123abc123' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
    });
    const body = (await res.json().catch(() => ({}))) as { result?: { isError?: boolean; content?: Array<{ text: string }> } };
    const texto = body.result?.content?.[0]?.text ?? '';
    let json: Json = {};
    try { json = JSON.parse(texto); } catch { /* texto livre */ }
    return { status: res.status, isError: body.result?.isError === true, texto, json };
  }
  const trilha = async (where = '') =>
    (await admin.query(`SELECT * FROM iam.permission_audit_log WHERE user_id = $1 ${where} ORDER BY created_at, id`, [UID])).rows;
  const wid = (k: string): string => ids[k];
  /** Impressão digital do ESTADO que a capability de escrita muda (cada uma na sua tabela): igual antes/depois = nenhuma mudança = falha. */
  const snapshot = async (workerId: string, tool = ''): Promise<string> => {
    const q = tool === 'worker.availability.set'
      ? `SELECT count(*)::text AS j FROM worker_availability WHERE worker_id = $1`
      : tool === 'worker.application.register'
        ? `SELECT count(*)::text AS j FROM worker_job_applications WHERE worker_id = $1`
        : tool === 'worker.optOut.register'
          ? `SELECT count(*)::text AS j FROM messaging_opt_out o JOIN workers w ON w.phone = o.phone WHERE w.id = $1`
          : `SELECT (to_jsonb(w) - 'updated_at')::text AS j FROM workers w WHERE id = $1`;
    return JSON.stringify((await admin.query(q, [workerId])).rows[0]?.j);
  };
  const diaDaSemana = 1;

  const CASOS: Caso[] = [
    { tool: 'worker.vacancies.list', write: false, w: 'wa', args: (i) => ({ workerId: i.wa }),
      dado: (j) => { expect(j.vacancies.length).toBeGreaterThanOrEqual(1); expect(j.vacancies.find((v: Json) => v.id === JP_AR)?.city).toBe('Palermo'); return `${j.vacancies.length} vaga(s), city AR visível`; } },
    // DEFEITO PRÉ-EXISTENTE (fora do escopo do agente; LISTA): a query lê `jp.patient_zone`, coluna que a migration 039 removeu de job_postings.
    // O teste NÃO esconde: exige o erro literal. Quando o defeito for consertado, o teste fica vermelho e esta entrada passa a exigir dado.
    { tool: 'worker.vacancies.nearby', write: false, w: 'wa', args: (i) => ({ workerId: i.wa }), defeito: /patient_zone/,
      dado: () => 'DEFEITO PRE-EXISTENTE: jp.patient_zone nao existe (migration 039)' },
    { tool: 'worker.interview.get', write: false, w: 'wa', args: (i) => ({ workerId: i.wa }),
      dado: (j) => { expect(j.interview).not.toBeNull(); expect(j.interview.vacancyTitle).toBe(`${P} vaga AR`); return `entrevista "${j.interview.vacancyTitle}"`; } },
    { tool: 'worker.profile.get', write: false, w: 'wa', args: (i) => ({ workerId: i.wa }),
      dado: (j, i) => { expect(JSON.stringify(j)).toContain(i.wa); return 'ficha do prestador'; } },
    { tool: 'worker.documents.list', write: false, w: 'wa', args: (i) => ({ workerId: i.wa }),
      dado: (j) => { expect(j).not.toBeNull(); expect(Object.keys(j).length).toBeGreaterThan(0); return 'linha de documentos'; } },
    { tool: 'worker.applications.list', write: false, w: 'wa', args: (i) => ({ workerId: i.wa }),
      dado: (j) => { expect(j.applications.length).toBeGreaterThanOrEqual(1); return `${j.applications.length} candidatura(s)`; } },
    { tool: 'worker.availability.get', write: false, w: 'wa', args: (i) => ({ workerId: i.wa }),
      dado: (j) => { expect(j.slots.length).toBeGreaterThanOrEqual(1); return `${j.slots.length} slot(s)`; } },
    { tool: 'worker.byPhone', write: false, w: 'wa', args: () => ({ phone: PHONE }),
      dado: (j, i) => { expect(j.found).toBe(true); expect(JSON.stringify(j.worker)).toContain(i.wa); return 'worker achado pelo telefone'; } },
    { tool: 'worker.availability.set', write: true, w: 'ws', args: (i) => ({ workerId: i.ws, slots: [{ dayOfWeek: diaDaSemana, startTime: '09:00', endTime: '12:00' }] }),
      dado: (j) => { expect(j.ok).toBe(true); return 'disponibilidade gravada'; } },
    { tool: 'worker.optOut.register', write: true, w: 'wo', args: (i) => ({ workerId: i.wo, reason: 'user_request' }),
      dado: (j) => { expect(j.ok).toBe(true); return 'opt-out registrado'; } },
    { tool: 'worker.account.deactivate', write: true, w: 'wd', args: (i) => ({ workerId: i.wd }),
      dado: (j) => { expect(j.ok).toBe(true); return 'conta desativada'; } },
    { tool: 'worker.profile.proposeUpdate', write: true, w: 'wp', args: (i) => ({ workerId: i.wp, fields: { firstName: 'Agcnovo' } }),
      dado: (j) => { expect(typeof j.handle).toBe('string'); ids.handle = j.handle; return 'proposta com handle'; } },
    { tool: 'worker.profile.confirmUpdate', write: true, w: 'wp', args: (i) => ({ workerId: i.wp, handle: i.handle }),
      dado: (j) => { expect(j.applied).toBe(true); expect(j.fieldsUpdated.length).toBeGreaterThanOrEqual(1); return `campos: ${j.fieldsUpdated.join(',')}`; } },
    { tool: 'worker.application.register', write: true, w: 'wr', args: (i) => ({ workerId: i.wr, jobPostingId: JP_NEW }),
      dado: (j) => { expect(j.ok).toBe(true); return 'candidatura registrada'; } },
    { tool: 'handover.notify', write: true, w: 'wa', args: () => ({ workerPhone: PHONE, team: 'recruitment', reason: 'e2e sintético', conversationId: 1 }),
      dado: (j) => { expect(j.skipped).toBe(true); return 'skipped (kill-switch OFF: nenhum canal tocado)'; } },
  ];

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await ensureLoginRole(admin, RT, PW, 'app_runtime');
    await ensureLoginRole(admin, SYS, PW, 'app_system');
    setEnv('DATABASE_URL', urlFor(ADMIN_URL, RT, PW));
    setEnv('DATABASE_SYSTEM_URL', urlFor(ADMIN_URL, SYS, PW));
    for (const [k, v] of Object.entries({ COUNTRY_RLS_ENABLED: 'true', USE_MOCK_AUTH: 'true', GCP_PROJECT_ID: 'enlite-e2e', PERMISSION_ENGINE_ENABLED: 'true', PERMISSION_CATALOG_SYNC_ENABLED: 'true', PERMISSION_CACHE_TTL_MS: '0' })) setEnv(k, v);
    for (const k of ['MCP_OAUTH_ENABLED', 'MCP_DB_RO_USER', 'HANDOVER_NOTIFY_ENABLED', 'PERISKOPE_GROUP_RECRUITMENT_ID', 'PERISKOPE_GROUP_COMMUNITY_ID']) setEnv(k, undefined);

    await limpar();
    await admin.query(`INSERT INTO users (firebase_uid, email, display_name, role, account_type, status, is_active, tenant_id) VALUES ($1, $2, 'AGC078', 'support', 'agent', 'ACTIVE', true, $3)`, [UID, EMAIL, TENANT]);
    gid = (await admin.query(`INSERT INTO iam.permission_groups (tenant_id, name, description, actor_class) VALUES ($1, $2, 'e2e', 'AGENT') RETURNING id`, [TENANT, GRUPO])).rows[0].id;
    for (const cell of celulasDoMapa) {
      const [resource, action] = cell.split(':');
      const r = await admin.query(`INSERT INTO iam.group_permissions (group_id, permission_id) SELECT $1, id FROM iam.permissions WHERE resource = $2 AND action = $3 AND deprecated_at IS NULL RETURNING 1`, [gid, resource, action]);
      if (r.rowCount !== 1) throw new Error(`célula ${cell} ausente do catálogo (sync do boot)`);
    }
    await admin.query(`INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason) VALUES ($1, 'AR', 'e2e', 'e2e')`, [gid]);
    await admin.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [UID, gid, TENANT]);

    // workers (AR, REGISTERED): wa = leituras; ws/wo/wd/wp/wr = um por escrita com efeito de estado
    for (const k of ['wa', 'ws', 'wo', 'wd', 'wp', 'wr']) {
      const phone = k === 'wa' ? PHONE : `+54911555780${['ws', 'wo', 'wd', 'wp', 'wr'].indexOf(k) + 2}0`;
      ids[k] = (await admin.query(`INSERT INTO workers (auth_uid, email, status, country, phone) VALUES ($1, $2, 'REGISTERED', 'AR', $3) RETURNING id`, [`${P}-${k}`, `${P}-${k}@e2e.local`, phone])).rows[0].id;
    }
    await admin.query(`INSERT INTO patients (id, clickup_task_id, first_name, last_name, country) VALUES ($1, '${P}-ar', 'Pac', 'Arg', 'AR'), ($2, '${P}-br', 'Pac', 'Bra', 'BR')`, [PAC_AR, PAC_BR]);
    await admin.query(`INSERT INTO patient_addresses (id, patient_id, country, city) VALUES ($1, $3, 'AR', 'Palermo'), ($2, $4, 'BR', 'Sao Paulo')`, [PA_AR, PA_BR, PAC_AR, PAC_BR]);
    for (const [id, tit, pat, pa] of [[JP_AR, `${P} vaga AR`, PAC_AR, PA_AR], [JP_BR, `${P} vaga BR`, PAC_BR, PA_BR], [JP_NEW, `${P} vaga nova`, PAC_AR, PA_AR]]) {
      await admin.query(`INSERT INTO job_postings (id, title, is_draft, status, patient_id, patient_address_id, case_number) VALUES ($1, $2, false, 'SEARCHING', $3, $4, $5)`, [id, tit, pat, pa, id === JP_AR ? 78001 : id === JP_BR ? 78002 : 78003]);
    }
    await admin.query(`INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage) VALUES ($1, $2, 'INVITED'), ($1, $3, 'INVITED')`, [ids.wa, JP_AR, JP_BR]);
    await admin.query(`INSERT INTO interview_slots (id, job_posting_id, slot_date, slot_time, slot_end_time) VALUES ($1, $2, (now() + interval '3 day')::date, '10:00', '10:30')`, [SLOT, JP_AR]);
    // o INSERT da candidatura já cria o encuadre (trigger): só liga o slot
    const enc = await admin.query(`UPDATE encuadres SET interview_slot_id = $3 WHERE worker_id = $1 AND job_posting_id = $2`, [ids.wa, JP_AR, SLOT]);
    if (enc.rowCount !== 1) throw new Error('encuadre da candidatura não nasceu (trigger)');
    await admin.query(`INSERT INTO worker_availability (worker_id, day_of_week, start_time, end_time, timezone) VALUES ($1, 2, '08:00', '12:00', 'America/Argentina/Buenos_Aires')`, [ids.wa]);
    await admin.query(`INSERT INTO worker_documents (worker_id) VALUES ($1)`, [ids.wa]);

    const express = (await import('express')).default;
    const { correlationMiddleware } = await import('@shared/logging/correlationMiddleware');
    const { dbSessionMiddleware } = await import('@shared/database/dbSessionMiddleware');
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    const { mountMcpRoutes } = await import('../../src/modules/mcp/bootstrap/mountMcpRoutes');
    appPool = DatabaseConnection.getInstance().getPool();
    const app: Express = express();
    app.use(express.json());
    app.use(correlationMiddleware);
    app.use(dbSessionMiddleware);
    mountMcpRoutes(app, appPool);
    const srv = app.listen(0);
    await new Promise<void>((r) => srv.once('listening', () => r()));
    servers.push(srv);
    url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  }, 90000);

  async function limpar(): Promise<void> {
    const w = `(SELECT id FROM workers WHERE auth_uid LIKE '${P}-%')`;
    await admin.query(`DELETE FROM resource_access_log WHERE operator_uid = $1`, [UID]).catch(() => undefined);
    await admin.query(`DELETE FROM iam.permission_audit_log WHERE user_id = $1`, [UID]);
    await admin.query(`DELETE FROM encuadres WHERE worker_id IN ${w}`);
    await admin.query(`DELETE FROM interview_slots WHERE id = $1`, [SLOT]);
    await admin.query(`DELETE FROM worker_job_applications WHERE worker_id IN ${w}`);
    await admin.query(`DELETE FROM worker_availability WHERE worker_id IN ${w}`);
    await admin.query(`DELETE FROM worker_documents WHERE worker_id IN ${w}`);
    await admin.query(`DELETE FROM job_postings WHERE id = ANY($1)`, [[JP_AR, JP_BR, JP_NEW]]);
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
    if (EVID && resumo.length) fs.appendFileSync(EVID, `${resumo.join('\n')}\n`);
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(async () => {
    await admin.query(`DELETE FROM iam.permission_audit_log WHERE user_id = $1`, [UID]);
  });

  it('as roles são as da stage (app_runtime sem bypass de RLS, declaradas); o mapa tem 15 capabilities e todas as células vivas', async () => {
    const r = await admin.query(`SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = $1`, [RT]);
    expect(r.rows).toEqual([{ rolname: RT, rolbypassrls: false, rolsuper: false }]);
    expect(AGENT_CAPABILITY_NAMES).toHaveLength(15);
    expect(CASOS.map((c) => c.tool).sort()).toEqual([...AGENT_CAPABILITY_NAMES].sort());
    const vivas = await admin.query(`SELECT count(*)::int AS n FROM iam.permissions WHERE deprecated_at IS NULL AND resource || ':' || action = ANY($1)`, [celulasDoMapa]);
    expect(vivas.rows[0].n).toBe(celulasDoMapa.length);
  });

  describe.each(CASOS)('$tool', (c) => {
    it(`COM a célula: devolve DADO${c.write ? ', muda estado, grava 1 linha ALLOW actor_kind=agente' : ''}`, async () => {
      const antes = c.write ? await snapshot(wid(c.w), c.tool) : '';
      const r = await rpc(c.tool, c.args(ids));
      if (c.defeito) {
        // a célula PASSOU (não é missing_cell) e a capability falhou por defeito próprio, que fica registrado
        expect([r.status, r.isError, r.json.code]).toEqual([200, true, undefined]);
        expect(r.texto).toMatch(c.defeito);
        resumo.push(`DEFEITO ${c.tool} cell=${AGENT_CAPABILITY_CELLS[c.tool]} erro="${r.texto.slice(0, 80)}"`);
        return;
      }
      expect([r.status, r.isError]).toEqual([200, false]);
      const dado = c.dado(r.json, ids);
      resumo.push(`CAPABILITY ${c.tool} cell=${AGENT_CAPABILITY_CELLS[c.tool]} write=${c.write} dado="${dado}"`);
      const l = await trilha(`AND decision = 'ALLOW'`);
      expect(l).toHaveLength(1);
      expect(l[0]).toMatchObject({ actor_kind: 'agente', user_id: UID, decision: 'ALLOW', gatilho_id: 'msg-agc-1' });
      if (c.write && c.tool !== 'handover.notify' && c.tool !== 'worker.profile.proposeUpdate') {
        expect(await snapshot(wid(c.w), c.tool)).not.toEqual(antes); // nenhuma mudança é falha
      }
    });

    it('SEM a célula: 403 missing_cell com a célula certa, nada executa e a recusa fica na trilha DENY', async () => {
      const cell = AGENT_CAPABILITY_CELLS[c.tool];
      const [resource, action] = cell.split(':');
      const antes = c.write ? await snapshot(wid(c.w), c.tool) : '';
      await admin.query(`DELETE FROM iam.group_permissions WHERE group_id = $1 AND permission_id IN (SELECT id FROM iam.permissions WHERE resource = $2 AND action = $3)`, [gid, resource, action]);
      try {
        const r = await rpc(c.tool, c.args(ids));
        expect([r.isError, r.json.code, r.json.cell]).toEqual([true, 'missing_cell', cell]);
        const neg = await trilha(`AND decision = 'DENY'`);
        expect(neg).toHaveLength(1); // a chamada FOI tentada (zero tentativas é falha)
        expect(neg[0]).toMatchObject({ actor_kind: 'agente', resource, action });
        if (c.write) expect(await snapshot(wid(c.w), c.tool)).toEqual(antes);
      } finally {
        await admin.query(`INSERT INTO iam.group_permissions (group_id, permission_id) SELECT $1, id FROM iam.permissions WHERE resource = $2 AND action = $3 AND deprecated_at IS NULL ON CONFLICT DO NOTHING`, [gid, resource, action]);
      }
      resumo.push(`BLOQUEADA_SEM_CELULA ${c.tool} cell=${cell}`);
    });
  });

  describe('país: o agente AR não vê o paciente BR (RLS), o contexto de sistema vê', () => {
    it('worker.vacancies.list: a vaga AR traz a cidade do paciente; a vaga BR (mesmo prestador) vem SEM cidade para o agente', async () => {
      const r = await rpc('worker.vacancies.list', { workerId: ids.wa });
      const ar = r.json.vacancies.find((v: Json) => v.id === JP_AR);
      const br = r.json.vacancies.find((v: Json) => v.id === JP_BR);
      expect(ar?.city).toBe('Palermo'); // AR >= 1 (contagem zero é falha)
      expect(br).toBeDefined();
      expect(br.city).toBeUndefined();
      const sistema = await admin.query(`SELECT city FROM patient_addresses WHERE id = $1`, [PA_BR]); // controle: o dono vê a cidade BR
      expect(sistema.rows[0].city).toBe('Sao Paulo');
    });
  });

  it('resumo: 15 capabilities — 14 com dado + 1 com defeito pré-existente nomeado; 15 bloqueadas sem célula', () => {
    const com = resumo.filter((l) => l.startsWith('CAPABILITY ')).length;
    const defeito = resumo.filter((l) => l.startsWith('DEFEITO ')).length;
    const sem = resumo.filter((l) => l.startsWith('BLOQUEADA_SEM_CELULA ')).length;
    resumo.push(`CAPABILIDADES(a): ${AGENT_CAPABILITY_NAMES.length} capabilities, ${com} com dado, ${defeito} com defeito pré-existente (célula passou), ${sem} bloqueadas sem célula`);
    expect([com, defeito, sem]).toEqual([14, 1, 15]);
  });
});
