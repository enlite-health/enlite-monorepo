const mockResolve = jest.fn();
jest.mock('../../../application/resolveCountryScope', () => ({
  resolveCountryScope: (...a: unknown[]) => mockResolve(...a),
  CountryScopeError: class CountryScopeError extends Error {
    constructor(public status: number, public code: string, m: string) { super(m); }
  },
}));
let ctxKind: 'staff' | 'system' = 'staff';
jest.mock('@shared/database/requestDbSession', () => ({
  currentDbContext: () => (ctxKind === 'staff' ? { kind: 'staff', uid: 'u1' } : { kind: 'system' }),
}));
jest.mock('@shared/logging', () => ({ reportError: jest.fn() }));

import express from 'express';
import request from 'supertest';
import { createAdminRecordCountryScopeRoutes } from '../adminRecordCountryScopeRoutes';
import { CountryScopeError } from '../../../application/resolveCountryScope';
import type { AuthMiddleware } from '../../middleware/AuthMiddleware';

const ID = '11111111-1111-4111-8111-111111111111';
const authOk = { requireStaffOrApiKey: () => (_q: unknown, _s: unknown, next: () => void) => next() } as unknown as AuthMiddleware;

function build(rows: Array<{ country: string }>) {
  const query = jest.fn().mockResolvedValue({ rows });
  const app = express();
  app.use('/api/admin', createAdminRecordCountryScopeRoutes(authOk, () => ({ query }) as never));
  // handlers "reais": so alcancados quando o guard deixa passar
  app.all('/api/admin/*', (_req, res) => res.status(200).json({ reached: true }));
  return { app, query };
}

describe('createAdminRecordCountryScopeRoutes — um guard para paciente, worker e vaga (e filhas, qualquer nome de param)', () => {
  beforeEach(() => { mockResolve.mockReset(); ctxKind = 'staff'; });

  it.each([
    [`/api/admin/patients/${ID}`, 'Patient not found'],
    [`/api/admin/patients/${ID}/addresses`, 'Patient not found'],
    [`/api/admin/patients/${ID}/contracted-services/${ID}/team`, 'Patient not found'],
    [`/api/admin/workers/${ID}`, 'Worker not found'],
    [`/api/admin/workers/${ID}/documents/save`, 'Worker not found'],
    [`/api/admin/vacancies/${ID}`, 'Vacancy not found'],
    [`/api/admin/vacancies/${ID}/enquadre-events`, 'Vacancy not found'],
  ])('registro BR com escopo [AR] => 404 em %s', async (path, error) => {
    mockResolve.mockResolvedValue({ countries: ['AR'], requested: 'ALL' });
    const { app, query } = build([{ country: 'BR' }]);
    const res = await request(app).get(path);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error });
    expect(query.mock.calls[0][0]).toMatch(/^SELECT country FROM (patients|workers|job_postings) WHERE id = \$1$/);
  });

  it('escopo [AR,BR] e registro AR passam ao handler', async () => {
    mockResolve.mockResolvedValue({ countries: ['AR', 'BR'], requested: 'ALL' });
    expect((await request(build([{ country: 'BR' }]).app).get(`/api/admin/patients/${ID}`)).body).toEqual({ reached: true });
    mockResolve.mockResolvedValue({ countries: ['AR'], requested: 'ALL' });
    expect((await request(build([{ country: 'AR ' }]).app).get(`/api/admin/workers/${ID}`)).body).toEqual({ reached: true });
  });

  it('sem pais => 403 COUNTRY_SCOPE_REQUIRED do resolvedor, handler NAO alcancado', async () => {
    mockResolve.mockRejectedValue(new (CountryScopeError as any)(403, 'COUNTRY_SCOPE_REQUIRED', 'sem pais'));
    const res = await request(build([{ country: 'AR' }]).app).get(`/api/admin/vacancies/${ID}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('COUNTRY_SCOPE_REQUIRED');
  });

  it('id nao-UUID (stats/map/baja), inexistente e chave de servico (kind=system) passam sem decidir escopo', async () => {
    const stats = build([{ country: 'BR' }]);
    expect((await request(stats.app).get('/api/admin/patients/stats')).body).toEqual({ reached: true });
    expect(stats.query).not.toHaveBeenCalled();
    mockResolve.mockResolvedValue({ countries: ['AR'], requested: 'ALL' });
    expect((await request(build([]).app).get(`/api/admin/patients/${ID}`)).body).toEqual({ reached: true });
    ctxKind = 'system';
    expect((await request(build([{ country: 'BR' }]).app).get(`/api/admin/workers/${ID}`)).body).toEqual({ reached: true });
    expect(mockResolve).toHaveBeenCalledTimes(1); // so a chamada do caso "inexistente"
  });

  it('falha inesperada => 500 fechado', async () => {
    mockResolve.mockRejectedValue(new Error('db down'));
    const res = await request(build([{ country: 'AR' }]).app).get(`/api/admin/patients/${ID}`);
    expect(res.status).toBe(500);
  });
});
