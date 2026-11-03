/**
 * Porta do agente ligada no /mcp (spec 078, M2.2.11): Express real + SDK MCP real + doubles de banco/identidade.
 * Provas: header do agente => ator (não sistema), sem header => caminho de hoje, sem downgrade, escrita pelo AgentCallGate (não pelo balde
 * em memória), legado pelo WriteRateLimiter como antes. A prova com Postgres/RLS reais é `tests/e2e/agent-porta-078.e2e.test.ts`.
 */
import express from 'express';
import request from 'supertest';
import { AGENT_ALLOWED_CAPABILITIES, AGENT_AUDIENCE, AGENT_IDENTITY_HEADER } from '../../domain/AgentCapabilityCells';
import { ServicePrincipal } from '../../domain/ServicePrincipal';

const mockSeen: Array<Record<string, unknown>> = [];
const mockSystemCtx = jest.fn();
const mockLegacyAuth = jest.fn();

jest.mock('@shared/database/systemContextMiddleware', () => ({
  systemContextMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => { mockSystemCtx(); next(); },
}));
jest.mock('../../interfaces/middleware/requireServicePrincipal', () => ({
  requireServicePrincipal: () => (req: { headers: Record<string, string>; servicePrincipal?: unknown }, res: { status(n: number): { json(b: unknown): void } }, next: () => void) => {
    mockLegacyAuth();
    if (req.headers.authorization !== 'Bearer legado-ok') { res.status(401).json({ error: 'Unauthorized' }); return; }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ServicePrincipal: SP } = require('../../domain/ServicePrincipal');
    req.servicePrincipal = new SP({ name: 'triage-service', allowedCapabilities: ['worker.vacancies.list', 'handover.notify'], tokenHashes: ['x'] });
    next();
  },
}));
// Sondas registradas SÓ no teste: leem o contexto de banco com que a capability roda.
jest.mock('../../application/capabilities/WorkerVacanciesListCapability', () => {
  class Sonda {
    static NAME = 'worker.vacancies.list';
    static DESCRIPTION = 'sonda';
    static INPUT_SHAPE = {};
    async execute() {
      const { currentDbContext } = require('@shared/database/requestDbSession');
      const { loggingAls } = require('@shared/logging');
      mockSeen.push({ ctx: currentDbContext() ?? null, actor: loggingAls.getStore()?.actor ?? null });
      return { ok: true };
    }
  }
  return { WorkerVacanciesListCapability: Sonda };
});
const mockHandover = jest.fn(async () => ({ sent: true }));
jest.mock('../../application/capabilities/HandoverNotifyCapability', () => {
  class Sonda {
    static NAME = 'handover.notify';
    static DESCRIPTION = 'sonda';
    static INPUT_SHAPE = {};
    execute() { return mockHandover(); }
  }
  return { HandoverNotifyCapability: Sonda };
});

import { mountMcpRoutes } from '../mountMcpRoutes';
import { AgentCallGate } from '../../application/AgentCallGate';
import { MockAgentIdentityVerifier } from '../../infrastructure/AgentIdentityVerifier';
import { correlationMiddleware } from '@shared/logging/correlationMiddleware';
import { dbSessionMiddleware } from '@shared/database/dbSessionMiddleware';

const SA = 'luz-sa@enlite-teste.iam.gserviceaccount.com';
const tok = (p: object = {}): string =>
  `Bearer mock_${Buffer.from(JSON.stringify({ email: SA, email_verified: true, aud: AGENT_AUDIENCE, ...p })).toString('base64')}`;

let status = 'ACTIVE';
const users = { findByEmail: jest.fn(async () => [{ uid: 'agent:luz', accountType: 'agent', status }]) };
const linhas: Array<{ uid: string; resource: string; action: string; decision: string; registroVersao: string; gatilhoId: string | null }> = [];
const gateSpy = jest.fn();
const gate = new AgentCallGate({
  guard: { check: async (_u, cap) => ({ ok: true, resource: cap === 'handover.notify' ? 'handover' : 'vacancy', action: cap === 'handover.notify' ? 'create' : 'read', exception: false }) },
  limiter: { admit: async (c) => { gateSpy(c); linhas.push({ ...c, decision: 'ALLOW' } as never); return { ok: true }; } },
  audit: { recordDeny: async () => undefined },
});
const pool = { query: jest.fn(async () => ({ rows: [{ countries: ['AR'] }] })), connect: jest.fn() };

function appComPorta() {
  const app = express();
  app.use(express.json());
  app.use(correlationMiddleware);
  app.use(dbSessionMiddleware);
  mountMcpRoutes(app, pool as never, { agent: { users, gate, verifier: new MockAgentIdentityVerifier() } });
  return app;
}
const chamar = (app: express.Express, headers: Record<string, string>, tool: string) =>
  request(app).post('/mcp/v1').set({ Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', ...headers })
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: {} } });
const texto = (r: request.Response): string => JSON.stringify(r.body);

describe('mountMcpRoutes — porta do agente (contrato §1, §3, §7)', () => {
  const env = { ...process.env };
  beforeAll(() => { process.env.DATABASE_URL = 'postgresql://sem:sem@127.0.0.1:1/sem'; // pool preguiçoso: nada conecta, o banco é dublê
    process.env.USE_MOCK_AUTH = 'true'; process.env.GCP_PROJECT_ID = 'enlite-teste'; delete process.env.MCP_OAUTH_ENABLED; delete process.env.MCP_DB_RO_USER; });
  afterAll(() => { process.env = env; });
  beforeEach(() => { mockSeen.length = 0; linhas.length = 0; mockSystemCtx.mockClear(); mockLegacyAuth.mockClear(); gateSpy.mockClear(); mockHandover.mockClear(); status = 'ACTIVE'; users.findByEmail.mockClear(); });

  it('COM header válido: NÃO passa por systemContextMiddleware (0 chamadas) e a capability roda como staff agent:luz, system_context vazio', async () => {
    const r = await chamar(appComPorta(), { [AGENT_IDENTITY_HEADER]: tok() }, 'worker.vacancies.list');
    expect(r.status).toBe(200);
    expect(texto(r)).toContain('ok');
    expect(mockSystemCtx).toHaveBeenCalledTimes(0);
    expect(mockLegacyAuth).toHaveBeenCalledTimes(0);
    expect(mockSeen).toHaveLength(1);
    expect(mockSeen[0].ctx).toMatchObject({ kind: 'staff', uid: 'agent:luz', countries: ['AR'] });
    expect((mockSeen[0].ctx as { systemContext?: string }).systemContext).toBeUndefined();
    expect(mockSeen[0].actor).toEqual({ source: 'luz_conversation', id: 'agent:luz' });
  });

  it('SEM header: segue exatamente o caminho de hoje (systemContext 1x, requireServicePrincipal 1x, contexto de SISTEMA)', async () => {
    const r = await chamar(appComPorta(), { Authorization: 'Bearer legado-ok' }, 'worker.vacancies.list');
    expect(r.status).toBe(200);
    expect(mockSystemCtx).toHaveBeenCalledTimes(1);
    expect(mockLegacyAuth).toHaveBeenCalledTimes(1);
    expect(gateSpy).not.toHaveBeenCalled();
    expect(users.findByEmail).not.toHaveBeenCalled();
  });

  it('header + Bearer legado VÁLIDO + identidade inválida -> 401 e requireServicePrincipal NÃO chamado (sem downgrade)', async () => {
    const r = await chamar(appComPorta(), { [AGENT_IDENTITY_HEADER]: tok({ aud: 'https://api.enlite.health/assistentes' }), Authorization: 'Bearer legado-ok' }, 'worker.vacancies.list');
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ code: 'AGENT_IDENTITY_INVALID' });
    expect(mockLegacyAuth).not.toHaveBeenCalled();
    expect(mockSystemCtx).not.toHaveBeenCalled();
    expect(mockSeen).toHaveLength(0);
  });

  it('o Bearer NÃO é lido para o agente: header válido + Bearer lixo -> 200 (a identidade é o ID token)', async () => {
    const r = await chamar(appComPorta(), { [AGENT_IDENTITY_HEADER]: tok(), Authorization: 'Bearer lixo' }, 'worker.vacancies.list');
    expect(r.status).toBe(200);
    expect(mockLegacyAuth).not.toHaveBeenCalled();
  });

  it('agente SUSPENDED -> 401 AGENT_DISABLED (status lido a cada request); religado -> 200', async () => {
    const app = appComPorta();
    status = 'SUSPENDED';
    const a = await chamar(app, { [AGENT_IDENTITY_HEADER]: tok() }, 'worker.vacancies.list');
    expect([a.status, a.body]).toEqual([401, { code: 'AGENT_DISABLED' }]);
    status = 'ACTIVE';
    expect((await chamar(app, { [AGENT_IDENTITY_HEADER]: tok() }, 'worker.vacancies.list')).status).toBe(200);
  });

  it('escrita do agente passa pelo AgentCallGate (1 linha, versão/gatilho dos headers) e NÃO pelo WriteRateLimiter: 12 escritas seguidas, nenhuma barrada pelo balde em memória (teto 10)', async () => {
    const app = appComPorta();
    for (let i = 0; i < 12; i += 1) {
      const r = await chamar(app, { [AGENT_IDENTITY_HEADER]: tok(), 'x-enlite-gatilho-id': 'm-1', 'x-enlite-registro-versao': 'abc123abc123' }, 'handover.notify');
      expect(texto(r)).not.toContain('Rate limit');
    }
    expect(gateSpy).toHaveBeenCalledTimes(12);
    expect(linhas[0]).toMatchObject({ uid: 'agent:luz', resource: 'handover', action: 'create', gatilhoId: 'm-1', registroVersao: 'abc123abc123' });
    expect(mockHandover).toHaveBeenCalledTimes(12);
  });

  it('principal LEGADO continua no WriteRateLimiter: a 11ª escrita é barrada pelo balde em memória e o gate do agente nem é tocado', async () => {
    const app = appComPorta();
    let ultima = '';
    for (let i = 0; i < 11; i += 1) ultima = texto(await chamar(app, { Authorization: 'Bearer legado-ok' }, 'handover.notify'));
    expect(ultima).toContain('Rate limit exceeded');
    expect(mockHandover).toHaveBeenCalledTimes(10);
    expect(gateSpy).not.toHaveBeenCalled();
  });

  it('o principal do agente só enxerga as capabilities do mapa (db.query.readonly etc. não são registradas)', async () => {
    const r = await request(appComPorta()).post('/mcp/v1').set({ Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', [AGENT_IDENTITY_HEADER]: tok() })
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const nomes = (r.body.result.tools as Array<{ name: string }>).map((t) => t.name).sort();
    expect(nomes).toEqual([...AGENT_ALLOWED_CAPABILITIES].sort()); // exatamente as 18 (15 da classe a + 3 da b), nem mais nem menos
    for (const proibida of ['worker.profile.update', 'worker.documents.upload', 'worker.search', 'worker.stats.get', 'agentes.placar.ler', 'db.query.readonly', 'patient.chat.map']) {
      expect(nomes).not.toContain(proibida);
    }
    expect(new ServicePrincipal({ name: 'x', allowedCapabilities: [], tokenHashes: ['x'] }).allowedCapabilities).toEqual([]);
  });
});
