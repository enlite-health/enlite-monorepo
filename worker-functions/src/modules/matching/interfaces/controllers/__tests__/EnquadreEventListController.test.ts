const mockResolveCountryScope = jest.fn();
const mockReportError = jest.fn();

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
  reportError: (...args: unknown[]) => mockReportError(...args),
}));

jest.mock('@shared/database/requestDbSession', () => ({
  currentDbContext: jest.fn().mockReturnValue({ kind: 'staff', uid: 'u1', country: 'AR' }),
}));

jest.mock('@modules/identity', () => {
  class CountryScopeError extends Error {
    constructor(public status: number, public code: string, message: string) {
      super(message);
    }
  }
  return {
    resolveCountryScope: (...args: unknown[]) => mockResolveCountryScope(...args),
    CountryScopeError,
  };
});

import type { Pool } from 'pg';
import { CountryScopeError } from '@modules/identity';
import { EnquadreEventListController } from '../EnquadreEventListController';

const DB = { query: jest.fn() } as unknown as Pool;

function makeReq(query: Record<string, unknown> = {}) {
  return { query } as unknown as import('express').Request;
}

function makeRes() {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  return res as unknown as import('express').Response & { status: jest.Mock; json: jest.Mock };
}

function build() {
  const execute = jest.fn().mockResolvedValue({
    items: [],
    total: 0,
    convokedTotal: 0,
    hosts: [],
    range: { from: '2026-10-26', to: '2026-11-01', defaulted: true },
  });
  return { controller: new EnquadreEventListController(DB, { execute }), execute };
}

describe('EnquadreEventListController.listAll', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveCountryScope.mockResolvedValue({ countries: ['AR'], requested: 'ALL' });
  });

  it('200: repassa o escopo de país do servidor ao caso de uso e devolve scope na resposta', async () => {
    const { controller, execute } = build();
    const res = makeRes();
    await controller.listAll(makeReq({ status: 'open,closed', limit: '20', offset: '40' }), res);
    expect(mockResolveCountryScope).toHaveBeenCalledWith(DB, 'u1', undefined);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ countries: ['AR'], from: null, to: null, statuses: ['open', 'closed'], limit: 20, offset: 40 }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].data.scope).toEqual({ countries: ['AR'], requested: 'ALL' });
  });

  it('status=foo → 400 INVALID_PARAMS e não chega ao caso de uso', async () => {
    const { controller, execute } = build();
    const res = makeRes();
    await controller.listAll(makeReq({ status: 'foo' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, code: 'INVALID_PARAMS' }));
    expect(execute).not.toHaveBeenCalled();
  });

  it('parâmetro desconhecido (.strict) → 400 INVALID_PARAMS', async () => {
    const { controller } = build();
    const res = makeRes();
    await controller.listAll(makeReq({ hostEmail: 'x@example.test' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_PARAMS' }));
  });

  it('só from → 400 ENQUADRE_LIST_RANGE_INCOMPLETE', async () => {
    const { controller, execute } = build();
    const res = makeRes();
    await controller.listAll(makeReq({ from: '2026-10-01' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'ENQUADRE_LIST_RANGE_INCOMPLETE' }));
    expect(execute).not.toHaveBeenCalled();
  });

  it('93 dias → 400 ENQUADRE_LIST_RANGE_TOO_LONG; 92 dias passa', async () => {
    const { controller, execute } = build();
    const long = makeRes();
    await controller.listAll(makeReq({ from: '2026-01-01', to: '2026-04-03' }), long);
    expect(long.status).toHaveBeenCalledWith(400);
    expect(long.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'ENQUADRE_LIST_RANGE_TOO_LONG' }));
    const ok = makeRes();
    await controller.listAll(makeReq({ from: '2026-01-01', to: '2026-04-02' }), ok);
    expect(ok.status).toHaveBeenCalledWith(200);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ from: '2026-01-01', to: '2026-04-02' }));
  });

  it('CountryScopeError → status e code dele, sem ecoar a mensagem', async () => {
    mockResolveCountryScope.mockRejectedValue(new CountryScopeError(403, 'COUNTRY_SCOPE_REQUIRED', 'detalhe interno do escopo'));
    const { controller, execute } = build();
    const res = makeRes();
    await controller.listAll(makeReq({ country: 'BR' }), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'COUNTRY_SCOPE_REQUIRED', code: 'COUNTRY_SCOPE_REQUIRED' });
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('detalhe interno');
    expect(execute).not.toHaveBeenCalled();
  });

  it('erro inesperado → 500 INTERNAL_ERROR sem a mensagem; reportError leva só a origem (sem q nem host)', async () => {
    const { controller, execute } = build();
    execute.mockRejectedValue(new Error('falha com Ficticio 01 e fulano@example.test'));
    const res = makeRes();
    await controller.listAll(makeReq({ q: 'Ficticio 01', host: 'Entrevistadora Ficticia 01' }), res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Internal error', code: 'INTERNAL_ERROR' });
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('Ficticio');
    expect(mockReportError).toHaveBeenCalledTimes(1);
    const ctx = mockReportError.mock.calls[0][1] as Record<string, unknown>;
    expect(ctx).toEqual({ source: 'EnquadreEventListController:listAll' });
    expect(JSON.stringify(ctx)).not.toContain('Ficticio');
  });
});
