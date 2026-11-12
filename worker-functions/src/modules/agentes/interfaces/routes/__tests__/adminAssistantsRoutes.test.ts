/**
 * Platform routes for the assistants service (spec 080, T057): reach, scoreboard, escalations.
 * Two identities (service via X-Enlite-Service + person via Authorization) and a cell. Fake repository:
 * the real `readScoreboardWith`/`registerEscalationWith` run in the e2e (T063). The service verifier is the REAL one, with the
 * google-auth-library `OAuth2Client` mocked (the route calls `requireAssistantsService()` without an argument).
 */
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';

const mockVerifyIdToken = jest.fn();
jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({ verifyIdToken: mockVerifyIdToken })),
}));

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('@shared/logging', () => ({
  logger: mockLogger,
  reportError: jest.fn(),
  loggingAls: { getStore: () => undefined },
}));

import { createAdminAssistantsRoutes } from '../adminAssistantsRoutes';
import { AssistantsPlatformController } from '../../controllers/AssistantsPlatformController';
import { AssistantReachUseCase } from '../../../application/AssistantReachUseCase';
import type { PlacarResult } from '../../../../mcp/infrastructure/AgentesRepository';

const SA = 'assistants-service-sa@test-project.iam.gserviceaccount.com';
const SERVICE = { 'X-Enlite-Service': 'Bearer tok-service' };
const PERSON = { Authorization: 'Bearer tok-person' };
const BOTH = { ...SERVICE, ...PERSON };

const FORBIDDEN_KEYS = [
  'texto', 'trecho', 'resumo', 'nome', 'telefone', 'conversa_ref', 'uid', 'email', 'actor', 'changed_by', // legacy vocabulary
  'text', 'excerpt', 'summary', 'name', 'phone', 'conversation_ref', // English vocabulary
];

const SCOREBOARD: PlacarResult = {
  operador: 'luz', de: '2026-10-01T00:00:00Z', ate: '2026-10-08T00:00:00Z', veredictos: 4, conversas: 3, nota_media: 7.5, cruza_areas: 1,
  por_regra: [{ regra_ref: 'R-12', violacoes: 2, gravidade_max: 'alta', veredicto_ids: ['11111111-1111-4111-8111-111111111111'] }],
  veredicto_ids: ['11111111-1111-4111-8111-111111111111'],
  graves: [{ veredicto_id: 'v', sensor: 'juiz', inbox: 'i', conversa_ref: 'c-1', ultima_msg_ref: 'm', regra_ref: 'R', gatilho: 'nunca', avaliado_em: '2026-10-02T00:00:00Z' }],
};
const QS = 'operator=luz&from=2026-10-01T00:00:00Z&to=2026-10-08T00:00:00Z';
const OBS = 'confidential-note-xyz-123';
const BODY = {
  gestora: 'maria', operador: 'luz', area: 'recrutamento', caso: 'leve', regra_ref: 'R-12',
  janela_de: '2026-10-01', janela_ate: '2026-10-07', observacao: OBS,
};

function keysOf(o: unknown, acc: string[] = []): string[] {
  if (Array.isArray(o)) o.forEach((x) => keysOf(x, acc));
  else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { acc.push(k); keysOf(v, acc); }
  return acc;
}

interface State { guardCells: string[]; personCells: string[]; escalations: Set<string> }
let st: State;
const registerEscalation = jest.fn();
const readScoreboard = jest.fn();

function build() {
  const resolveCells = jest.fn(async () => st.personCells);
  const controller = new AssistantsPlatformController({
    reach: new AssistantReachUseCase(resolveCells),
    resolveCells,
    readScoreboard,
    registerEscalation,
  });
  // Fakes of AuthMiddleware/PermissionMiddleware: the array order is the real one; only the guards are doubles.
  const auth = {
    requireStaff: () => (req: Request, res: Response, next: NextFunction) => {
      const h = req.headers.authorization;
      if (!h || !h.startsWith('Bearer ')) return void res.status(401).json({ error: 'Unauthenticated' });
      (req as unknown as { authContext: unknown }).authContext = { principal: { id: 'uid-person' } };
      next();
    },
  };
  const perms = {
    family: () => ({
      require: (resource: string, action: string) => (_req: Request, res: Response, next: NextFunction) =>
        st.guardCells.includes(`${resource}:${action}`) ? next() : void res.status(403).json({ error: 'missing_cell' }),
    }),
  };
  const app = express();
  app.use(express.json());
  app.use('/api/admin', createAdminAssistantsRoutes(controller, auth as never, perms as never));
  return { app, resolveCells };
}

describe('/api/admin assistants routes (platform)', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv, GCP_PROJECT_ID: 'test-project' };
    delete process.env.USE_MOCK_AUTH;
    jest.clearAllMocks();
    mockVerifyIdToken.mockImplementation(async ({ idToken }: { idToken: string }) => {
      if (idToken !== 'tok-service') throw new Error('invalid');
      return { getPayload: () => ({ email: SA, email_verified: true }) };
    });
    st = { guardCells: [], personCells: [], escalations: new Set() };
    readScoreboard.mockResolvedValue(SCOREBOARD);
    registerEscalation.mockImplementation(async (_uid: string, e: { operator: string; kind: string }) => {
      const key = `${e.operator}|${e.kind}`;
      if (st.escalations.has(key)) return { id: 'rep-1', duplicate: true as const };
      st.escalations.add(key);
      return { id: 'rep-1' };
    });
  });
  afterEach(() => { process.env = originalEnv; });

  describe('GET /assistants/reach', () => {
    it('both identities -> 200 with the cells of the person', async () => {
      st.personCells = ['assistant_maria:chat', 'knowledge_public:read', 'knowledge_default:read'];
      const { app } = build();
      const r = await request(app).get('/api/admin/assistants/reach').set(BOTH);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ uid: 'uid-person', assistants: ['maria'], knowledge: ['PUBLIC'] });
    });
    it('only the person identity -> 401', async () => {
      const r = await request(build().app).get('/api/admin/assistants/reach').set(PERSON);
      expect(r.status).toBe(401);
      expect(r.body).toEqual({ error: 'SERVICE_NOT_AUTHENTICATED' });
    });
    it('only the service identity -> 401', async () => {
      const r = await request(build().app).get('/api/admin/assistants/reach').set(SERVICE);
      expect(r.status).toBe(401);
    });
    it('failure to resolve the cells -> 500, never an empty list', async () => {
      const { app, resolveCells } = build();
      resolveCells.mockRejectedValueOnce(new Error('cloud sql'));
      const r = await request(app).get('/api/admin/assistants/reach').set(BOTH);
      expect(r.status).toBe(500);
      expect(r.body.assistants).toBeUndefined();
    });
  });

  describe('GET /assistants/scoreboard', () => {
    it('only the person identity -> 401 (the service is missing)', async () => {
      st.guardCells = ['assistant_scoreboard:read'];
      const r = await request(build().app).get(`/api/admin/assistants/scoreboard?${QS}`).set(PERSON);
      expect(r.status).toBe(401);
      expect(readScoreboard).not.toHaveBeenCalled();
    });
    it('without assistant_scoreboard:read -> 403', async () => {
      const r = await request(build().app).get(`/api/admin/assistants/scoreboard?${QS}`).set(BOTH);
      expect(r.status).toBe(403);
      expect(readScoreboard).not.toHaveBeenCalled();
    });
    it('with the cell -> 200 and the output has no forbidden keys (recursive); the query reaches the function in English', async () => {
      st.guardCells = ['assistant_scoreboard:read'];
      const r = await request(build().app).get(`/api/admin/assistants/scoreboard?${QS}`).set(BOTH);
      expect(r.status).toBe(200);
      expect(readScoreboard).toHaveBeenCalledWith('uid-person', { operator: 'luz', from: '2026-10-01T00:00:00Z', to: '2026-10-08T00:00:00Z' });
      const found = keysOf(r.body);
      expect(found).toEqual(expect.arrayContaining(['operador', 'veredictos', 'por_regra', 'regra_ref', 'gravidade_max']));
      for (const forbidden of FORBIDDEN_KEYS) expect(found).not.toContain(forbidden);
      expect(found).not.toContain('graves');
      expect(found).not.toContain('veredicto_ids');
    });
    it('invalid query -> 400 (including the legacy names operador/de/ate)', async () => {
      st.guardCells = ['assistant_scoreboard:read'];
      const r = await request(build().app).get('/api/admin/assistants/scoreboard?operator=Luz&from=x&to=y').set(BOTH);
      expect(r.status).toBe(400);
      const legacy = await request(build().app).get('/api/admin/assistants/scoreboard?operador=luz&de=2026-10-01T00:00:00Z&ate=2026-10-08T00:00:00Z').set(BOTH);
      expect(legacy.status).toBe(400);
    });
  });

  describe('POST /assistants/escalations', () => {
    beforeEach(() => {
      st.guardCells = ['assistant_escalation:register'];
      st.personCells = ['assistant_maria:chat'];
    });
    it('without assistant_escalation:register -> 403', async () => {
      st.guardCells = [];
      const r = await request(build().app).post('/api/admin/assistants/escalations').set(BOTH).send(BODY);
      expect(r.status).toBe(403);
      expect(registerEscalation).not.toHaveBeenCalled();
    });
    it('only the person identity -> 401', async () => {
      const r = await request(build().app).post('/api/admin/assistants/escalations').set(PERSON).send(BODY);
      expect(r.status).toBe(401);
    });
    it('escalation cell without reach to Maria -> 403 NO_REACH_TO_ASSISTANT', async () => {
      st.personCells = ['assistant_lucero:chat'];
      const r = await request(build().app).post('/api/admin/assistants/escalations').set(BOTH).send(BODY);
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ error: 'NO_REACH_TO_ASSISTANT' });
      expect(registerEscalation).not.toHaveBeenCalled();
    });
    it('body with an extra field -> 400 (.strict())', async () => {
      const r = await request(build().app).post('/api/admin/assistants/escalations').set(BOTH).send({ ...BODY, trecho: 'x' });
      expect(r.status).toBe(400);
      expect(registerEscalation).not.toHaveBeenCalled();
    });
    it('assistant outside the catalog constants -> 400', async () => {
      const r = await request(build().app).post('/api/admin/assistants/escalations').set(BOTH).send({ ...BODY, gestora: 'luz' });
      expect(r.status).toBe(400);
    });
    it('observacao > 500 -> 400', async () => {
      const r = await request(build().app).post('/api/admin/assistants/escalations').set(BOTH).send({ ...BODY, observacao: 'a'.repeat(501) });
      expect(r.status).toBe(400);
    });
    it('201 the 1st time and 200 duplicado:true the 2nd; the legacy body reaches the function as English arguments', async () => {
      const { app } = build();
      const a = await request(app).post('/api/admin/assistants/escalations').set(BOTH).send(BODY);
      expect(a.status).toBe(201);
      expect(a.body).toEqual({ id: 'rep-1' });
      const b = await request(app).post('/api/admin/assistants/escalations').set(BOTH).send(BODY);
      expect(b.status).toBe(200);
      expect(b.body).toEqual({ id: 'rep-1', duplicado: true });
      expect(registerEscalation).toHaveBeenCalledWith(
        'uid-person',
        expect.objectContaining({
          author: 'maria', operator: 'luz', area: 'recrutamento', kind: 'LIGHT', rule_ref: 'R-12',
          window_from: '2026-10-01', window_to: '2026-10-07', note: OBS, verdict_ids: [],
        }),
      );
      // `caso` maps to `kind` in the three values
      await request(app).post('/api/admin/assistants/escalations').set(BOTH).send({ ...BODY, caso: 'reforco' });
      await request(app).post('/api/admin/assistants/escalations').set(BOTH).send({ ...BODY, caso: 'meta', regra_ref: undefined });
      expect(registerEscalation.mock.calls.map((c) => c[1].kind)).toEqual(['LIGHT', 'LIGHT', 'REINFORCEMENT', 'META']);
    });
    it('observacao is never logged (not even on the error path)', async () => {
      const { app } = build();
      await request(app).post('/api/admin/assistants/escalations').set(BOTH).send(BODY);
      registerEscalation.mockRejectedValueOnce(Object.assign(new Error(`DETAIL: ${OBS}`), { name: 'DbError' }));
      const failed = await request(app).post('/api/admin/assistants/escalations').set(BOTH).send({ ...BODY, caso: 'meta' });
      expect(failed.status).toBe(500);
      expect(failed.body).toEqual({ error: 'ESCALATION_FAILED' });
      const logs = [mockLogger.info, mockLogger.warn, mockLogger.error, mockLogger.debug]
        .flatMap((f) => f.mock.calls)
        .map((c) => JSON.stringify(c))
        .join('\n');
      expect(logs.length).toBeGreaterThan(0);
      expect(logs).not.toContain(OBS);
    });
  });
});
