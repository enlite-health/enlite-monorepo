const mockResolve = jest.fn();
jest.mock('../../../application/resolveCountryScope', () => ({
  resolveCountryScope: (...a: unknown[]) => mockResolve(...a),
  CountryScopeError: class CountryScopeError extends Error {
    constructor(public status: number, public code: string, m: string) { super(m); }
  },
}));
// ALS REAL: `requireAuth` (a mesma das rotas) carimba o contexto de banco via rememberActorInAls; o guard le `currentDbContext()`.
jest.mock('@shared/logging', () => {
  const { AsyncLocalStorage } = require('async_hooks');
  const l: Record<string, unknown> = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  l.child = () => l;
  return { logger: l, reportError: jest.fn(), loggingAls: new AsyncLocalStorage() };
});

import express from 'express';
import request from 'supertest';
import { loggingAls } from '@shared/logging';
import { createAdminRecordCountryScopeRoutes, MudoRes } from '../adminRecordCountryScopeRoutes';
import { CountryScopeError } from '../../../application/resolveCountryScope';
import { AuthMiddleware } from '../../middleware/AuthMiddleware';
import { MultiAuthService } from '../../../infrastructure/MultiAuthService';

const ID = '11111111-1111-4111-8111-111111111111';
const ctx = (id: string, roles: string[], accountType: string) => ({
  principal: { id, type: 'USER', roles, accountType },
  credentials: { type: 'GOOGLE_ID_TOKEN', token: '', scopes: [] },
  metadata: {},
});

/**
 * MultiAuthService de verdade no que importa para a paridade: `parseCredentials` e o REAL (le Authorization Bearer,
 * `x-google-id-token`, `x-api-key`...); so a verificacao do token e dublada.
 */
function multiAuth(over: { authenticate?: (c: { token: string }) => Promise<unknown> } = {}): MultiAuthService {
  const svc = Object.create(MultiAuthService.prototype) as MultiAuthService & Record<string, unknown>;
  const verify = over.authenticate ?? (async (c: { token: string }) => {
    if (c.token === 'staff-ar') return ctx('u1', ['admin'], 'staff');
    if (c.token === 'worker') return ctx('w1', ['worker'], 'worker');
    return null;
  });
  svc.authenticate = verify as never;
  svc.authenticateGoogleIdToken = ((t: string | { token: string }) => verify({ token: typeof t === 'string' ? t : t.token })) as never;
  svc.tryAuthenticateAsApiKey = ((t: string) => (t === 'key-1' ? { principal: { id: 'triage', type: 'SERVICE', roles: [] }, credentials: {}, metadata: {} } : null)) as never;
  return svc;
}

function build(rows: Array<{ country: string }>, auth: MultiAuthService = multiAuth()) {
  const query = jest.fn().mockResolvedValue({ rows });
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, _res, next) => loggingAls.run({ dbSession: { released: false } } as never, () => next()));
  app.use('/api/admin', createAdminRecordCountryScopeRoutes(new AuthMiddleware(auth, {} as never), () => ({ query }) as never));
  // handler "real": so alcancado se o guard deixar; devolve o que a auth do guard deixou no `res` real
  app.all('/api/admin/*', (_req, res) => res.status(200).json({ reached: true, headersSent: res.headersSent, headers: res.getHeaders() }));
  return { app, query };
}

const STAFF_BEARER = { Authorization: 'Bearer staff-ar' };
const STAFF_XGOOGLE = { 'x-google-id-token': 'staff-ar' }; // a rota aceita; o guard antigo (so Bearer) nao via

describe('createAdminRecordCountryScopeRoutes — um guard para paciente, worker e vaga (e filhas), autenticando como as rotas', () => {
  beforeEach(() => { mockResolve.mockReset(); delete process.env.USE_MOCK_AUTH; });

  it.each([
    [`/api/admin/patients/${ID}`, 'Patient not found'],
    [`/api/admin/patients/${ID}/addresses`, 'Patient not found'],
    [`/api/admin/patients/${ID}/contracted-services/${ID}/team`, 'Patient not found'],
    [`/api/admin/workers/${ID}`, 'Worker not found'],
    [`/api/admin/workers/${ID}/documents/save`, 'Worker not found'],
    [`/api/admin/vacancies/${ID}`, 'Vacancy not found'],
    [`/api/admin/vacancies/${ID}/enquadre-events`, 'Vacancy not found'],
  ])('staff so-AR (Bearer) + registro BR => 404 em %s', async (path, error) => {
    mockResolve.mockResolvedValue({ countries: ['AR'], requested: 'ALL' });
    const { app, query } = build([{ country: 'BR' }]);
    const res = await request(app).get(path).set(STAFF_BEARER);
    expect([res.status, res.body]).toEqual([404, { success: false, error }]);
    expect(query.mock.calls[0][0]).toMatch(/^SELECT country FROM (patients|workers|job_postings) WHERE id = \$1$/);
  });

  it.each([
    [`/api/admin/patients/${ID}`],
    [`/api/admin/workers/${ID}/additional-documents`],
    [`/api/admin/vacancies/${ID}`],
  ])('BYPASS DO GATE: staff so-AR so com `x-google-id-token` (sem Authorization) + registro BR => 404 em %s', async (path) => {
    mockResolve.mockResolvedValue({ countries: ['AR'], requested: 'ALL' });
    const { app } = build([{ country: 'BR' }]);
    const res = await request(app).get(path).set(STAFF_XGOOGLE);
    expect(res.status).toBe(404);
    expect(res.body.reached).toBeUndefined();
  });

  it('escopo [AR,BR] e registro AR passam ao handler; a auth do guard NAO toca o res real (sem header, headersSent=false)', async () => {
    mockResolve.mockResolvedValue({ countries: ['AR', 'BR'], requested: 'ALL' });
    const a = await request(build([{ country: 'BR' }]).app).get(`/api/admin/patients/${ID}`).set(STAFF_BEARER);
    expect(a.body).toEqual({ reached: true, headersSent: false, headers: {} });
    mockResolve.mockResolvedValue({ countries: ['AR'], requested: 'ALL' });
    const b = await request(build([{ country: 'AR ' }]).app).get(`/api/admin/workers/${ID}`).set(STAFF_XGOOGLE);
    expect(b.body).toEqual({ reached: true, headersSent: false, headers: {} });
  });

  it('staff sem pais => 403 COUNTRY_SCOPE_REQUIRED do resolvedor, handler NAO alcancado', async () => {
    mockResolve.mockRejectedValue(new (CountryScopeError as any)(403, 'COUNTRY_SCOPE_REQUIRED', 'sem pais'));
    const res = await request(build([{ country: 'AR' }]).app).get(`/api/admin/vacancies/${ID}`).set(STAFF_XGOOGLE);
    expect([res.status, res.body.error]).toEqual([403, 'COUNTRY_SCOPE_REQUIRED']);
  });

  it('NAO autenticou (sem credencial / credencial ruim) => FAIL-CLOSED: o guard responde 401 como a rota; handler e banco NAO alcancados', async () => {
    const { app, query } = build([{ country: 'BR' }]);
    const sem = await request(app).get(`/api/admin/patients/${ID}`);
    expect([sem.status, sem.body]).toEqual([401, { success: false, error: 'Authentication required' }]);
    const ruim = await request(app).get(`/api/admin/patients/${ID}`).set('x-google-id-token', 'lixo');
    expect([ruim.status, ruim.body]).toEqual([401, { success: false, error: 'Invalid credentials' }]);
    const ruimBearer = await request(app).get(`/api/admin/patients/${ID}`).set('Authorization', 'Bearer lixo');
    expect(ruimBearer.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('autenticou como NAO-staff (worker) => next(): a rota por id e quem nega (403); o guard nao consulta pais', async () => {
    const { app, query } = build([{ country: 'BR' }]);
    const res = await request(app).get(`/api/admin/workers/${ID}`).set('x-google-id-token', 'worker');
    expect(res.body.reached).toBe(true);
    expect(query).not.toHaveBeenCalled();
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('chave de servico (Bearer) => passa (kind=system, decisao pendente), sem resolver escopo', async () => {
    const { app, query } = build([{ country: 'BR' }]);
    const res = await request(app).get(`/api/admin/workers/${ID}`).set('Authorization', 'Bearer key-1');
    expect(res.body.reached).toBe(true);
    expect(query).not.toHaveBeenCalled();
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('EXCECAO na auth (infra) => FAIL-CLOSED 500 do requireAuth replicado; handler NAO alcancado, request nao pendura', async () => {
    const { app, query } = build([{ country: 'BR' }], multiAuth({ authenticate: async () => { throw new Error('firebase fora'); } }));
    const res = await request(app).get(`/api/admin/patients/${ID}`).set(STAFF_XGOOGLE);
    expect([res.status, res.body]).toEqual([500, { success: false, error: 'Authentication error' }]);
    expect(query).not.toHaveBeenCalled();
  });

  it('id nao-UUID (stats/map/baja) e registro inexistente passam; falha inesperada do banco => 500 fechado', async () => {
    const stats = build([{ country: 'BR' }]);
    expect((await request(stats.app).get('/api/admin/patients/stats')).body.reached).toBe(true); // nem auth nem consulta
    expect(stats.query).not.toHaveBeenCalled();
    mockResolve.mockResolvedValue({ countries: ['AR'], requested: 'ALL' });
    expect((await request(build([]).app).get(`/api/admin/patients/${ID}`).set(STAFF_BEARER)).body.reached).toBe(true);
    mockResolve.mockRejectedValue(new Error('db down'));
    expect((await request(build([{ country: 'AR' }]).app).get(`/api/admin/patients/${ID}`).set(STAFF_BEARER)).status).toBe(500);
  });

  it('MudoRes registra TODA escrita e e independente do res real (metodo desconhecido nao estoura)', () => {
    const m = new MudoRes();
    (m as any).status(401).json({ a: 1 });
    (m as any).qualquerMetodoNovo('x');
    expect([m.statusCode, m.body, m.written, m.headersSent]).toEqual([401, { a: 1 }, true, false]);
    expect(m.calls).toEqual(expect.arrayContaining(['status', 'json', 'qualquerMetodoNovo']));
  });
});
