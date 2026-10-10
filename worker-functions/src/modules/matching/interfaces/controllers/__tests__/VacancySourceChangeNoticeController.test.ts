/**
 * VacancySourceChangeNoticeController — POST /api/admin/vacancies/:id/source-change-notices/:field/ack (F3).
 * Pool mockado; o SQL real é o e2e `tests/e2e/vacancySourceChangeNotice.e2e.test.ts`.
 */
const mockQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({ query: (...a: unknown[]) => mockQuery(...a) }) }) },
}));
const mockReport = jest.fn();
jest.mock('@shared/logging', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }, reportError: (...a: unknown[]) => mockReport(...a) }));

import type { Request, Response } from 'express';
import { VacancySourceChangeNoticeController } from '../VacancySourceChangeNoticeController';

const VAC = '5b0c3a52-7a4e-4f0e-9a58-2a1c3f6a7d11';

function call(params: Record<string, string>, user: Record<string, unknown> | null = { uid: 'u-1', email: 'u@x.test' }) {
  const res = { json: jest.fn().mockReturnThis(), status: jest.fn().mockReturnThis() } as unknown as Response;
  const req = { params, user: user ?? undefined } as unknown as Request;
  return { req, res };
}

beforeEach(() => jest.clearAllMocks());

describe('VacancySourceChangeNoticeController.acknowledge', () => {
  it('ack de aviso aberto → 200 e grava acknowledged_by = ator staff', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 'n-1' }] });
    const { req, res } = call({ id: VAC, field: 'schedule' });
    await new VacancySourceChangeNoticeController().acknowledge(req, res);
    expect(res.json).toHaveBeenCalledWith({ success: true });
    expect(res.status).not.toHaveBeenCalled();
    expect(mockQuery.mock.calls[0][1]).toEqual([VAC, 'schedule', 'staff:u-1']);
  });

  it('ack com `field` fora do conjunto fechado → 400, nada consultado', async () => {
    const { req, res } = call({ id: VAC, field: 'address' });
    await new VacancySourceChangeNoticeController().acknowledge(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('id que não é UUID → 400, nada consultado', async () => {
    const { req, res } = call({ id: 'v1', field: 'schedule' });
    await new VacancySourceChangeNoticeController().acknowledge(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('sem usuário no request → 401', async () => {
    const { req, res } = call({ id: VAC, field: 'schedule' }, null);
    await new VacancySourceChangeNoticeController().acknowledge(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('nenhum aviso aberto para (vaga, campo) → 404', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const { req, res } = call({ id: VAC, field: 'schedule' });
    await new VacancySourceChangeNoticeController().acknowledge(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('erro de banco → 500 e reportError (Error ou não-Error)', async () => {
    mockQuery.mockRejectedValueOnce(new Error('boom'));
    const a = call({ id: VAC, field: 'schedule' });
    await new VacancySourceChangeNoticeController().acknowledge(a.req, a.res);
    expect(a.res.status).toHaveBeenCalledWith(500);
    mockQuery.mockRejectedValueOnce('texto');
    const b = call({ id: VAC, field: 'schedule' });
    await new VacancySourceChangeNoticeController().acknowledge(b.req, b.res);
    expect(b.res.status).toHaveBeenCalledWith(500);
    expect(mockReport).toHaveBeenCalledTimes(2);
  });

  it('pool injetado tem precedência sobre o singleton', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [{ id: 'n' }] }) };
    const { req, res } = call({ id: VAC, field: 'age_range' });
    await new VacancySourceChangeNoticeController(pool as never).acknowledge(req, res);
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });
});
