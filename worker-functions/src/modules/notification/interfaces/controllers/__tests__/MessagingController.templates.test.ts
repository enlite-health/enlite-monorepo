/**
 * MessagingController.templates.test.ts
 *
 * Cobre listTemplates / createTemplate / updateTemplate / deleteTemplate /
 * bulkDispatchIncomplete — extraído de MessagingController.bulk.test.ts para
 * manter os dois arquivos ≤400 linhas (regra do CLAUDE.md).
 */

import { Request, Response } from 'express';
import { MessagingController } from '../MessagingController';

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue(null),
    }),
  },
}));

jest.mock('@modules/identity', () => ({
  AuthMiddleware: {
    getAuthContext: jest.fn().mockReturnValue({
      principal: { id: 'user-abc-123', type: 'admin', roles: ['admin'] },
    }),
  },
}));

jest.mock('@shared/logging', () => ({
  logger: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    child: jest.fn().mockReturnThis(),
  },
  reportError: jest.fn(),
}));

const mockBulkExecute = jest.fn();
jest.mock('../../../application/BulkDispatchIncompleteWorkersUseCase', () => ({
  BulkDispatchIncompleteWorkersUseCase: jest.fn().mockImplementation(() => ({
    execute: (...args: unknown[]) => mockBulkExecute(...args),
  })),
}));

function mockRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json:   jest.fn().mockReturnThis(),
  } as unknown as Response;
}

function makeReq(body: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Request {
  return { body, query: {}, params: {}, ...extra } as unknown as Request;
}

// ── listTemplates ───────────────────────────────────────────────────────────────

describe('MessagingController.listTemplates', () => {
  let mockTemplateRepo: { findAll: jest.Mock; upsert: jest.Mock; deactivate: jest.Mock };
  let controller: MessagingController;

  beforeEach(() => {
    jest.clearAllMocks();
    mockTemplateRepo = {
      findAll: jest.fn().mockResolvedValue([{ slug: 'x' }]),
      upsert: jest.fn(),
      deactivate: jest.fn(),
    };
    controller = new MessagingController({} as any, mockTemplateRepo as any);
  });

  it('sem query params → onlyActive=true, requireContentSid=true', async () => {
    const res = mockRes();
    await controller.listTemplates(makeReq({}, { query: {} }), res);

    expect(mockTemplateRepo.findAll).toHaveBeenCalledWith(true, true);
    expect(res.status).toHaveBeenCalledWith(200);
    expect((res.json as jest.Mock).mock.calls[0][0]).toEqual({ success: true, data: [{ slug: 'x' }] });
  });

  it('?all=true → onlyActive=false', async () => {
    const res = mockRes();
    await controller.listTemplates(makeReq({}, { query: { all: 'true' } }), res);

    expect(mockTemplateRepo.findAll).toHaveBeenCalledWith(false, true);
  });

  it('?includeUnlinked=true → requireContentSid=false', async () => {
    const res = mockRes();
    await controller.listTemplates(makeReq({}, { query: { includeUnlinked: 'true' } }), res);

    expect(mockTemplateRepo.findAll).toHaveBeenCalledWith(true, false);
  });
});

// ── createTemplate ───────────────────────────────────────────────────────────────

describe('MessagingController.createTemplate', () => {
  let mockTemplateRepo: { findAll: jest.Mock; upsert: jest.Mock; deactivate: jest.Mock };
  let controller: MessagingController;

  beforeEach(() => {
    jest.clearAllMocks();
    mockTemplateRepo = { findAll: jest.fn(), upsert: jest.fn(), deactivate: jest.fn() };
    controller = new MessagingController({} as any, mockTemplateRepo as any);
  });

  it('faltando slug/name/body → 400, não chama upsert', async () => {
    const res = mockRes();
    await controller.createTemplate(makeReq({ slug: 'x' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockTemplateRepo.upsert).not.toHaveBeenCalled();
  });

  it('criado (created=true) → 201', async () => {
    mockTemplateRepo.upsert.mockResolvedValueOnce({ entity: { slug: 'x', name: 'X', body: 'b' }, created: true });
    const res = mockRes();
    await controller.createTemplate(makeReq({ slug: 'x', name: 'X', body: 'b', category: 'cat' }), res);

    expect(mockTemplateRepo.upsert).toHaveBeenCalledWith({ slug: 'x', name: 'X', body: 'b', category: 'cat' });
    expect(res.status).toHaveBeenCalledWith(201);
    expect((res.json as jest.Mock).mock.calls[0][0]).toEqual({ success: true, data: { slug: 'x', name: 'X', body: 'b' } });
  });

  it('atualizado (created=false) → 200', async () => {
    mockTemplateRepo.upsert.mockResolvedValueOnce({ entity: { slug: 'x', name: 'X', body: 'b' }, created: false });
    const res = mockRes();
    await controller.createTemplate(makeReq({ slug: 'x', name: 'X', body: 'b' }), res);

    expect(res.status).toHaveBeenCalledWith(200);
  });
});

// ── updateTemplate ───────────────────────────────────────────────────────────────

describe('MessagingController.updateTemplate', () => {
  let mockTemplateRepo: { findAll: jest.Mock; upsert: jest.Mock; deactivate: jest.Mock };
  let controller: MessagingController;

  beforeEach(() => {
    jest.clearAllMocks();
    mockTemplateRepo = { findAll: jest.fn(), upsert: jest.fn(), deactivate: jest.fn() };
    controller = new MessagingController({} as any, mockTemplateRepo as any);
  });

  it('faltando name/body → 400, não chama upsert', async () => {
    const res = mockRes();
    await controller.updateTemplate(makeReq({ category: 'cat' }, { params: { slug: 'x' } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockTemplateRepo.upsert).not.toHaveBeenCalled();
  });

  it('atualiza e retorna 200 com a entidade', async () => {
    mockTemplateRepo.upsert.mockResolvedValueOnce({ entity: { slug: 'x', name: 'Novo nome', body: 'novo body' }, created: false });
    const res = mockRes();
    await controller.updateTemplate(
      makeReq({ name: 'Novo nome', body: 'novo body', category: 'cat', isActive: true }, { params: { slug: 'x' } }),
      res,
    );

    expect(mockTemplateRepo.upsert).toHaveBeenCalledWith({
      slug: 'x', name: 'Novo nome', body: 'novo body', category: 'cat', isActive: true,
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect((res.json as jest.Mock).mock.calls[0][0]).toEqual({
      success: true, data: { slug: 'x', name: 'Novo nome', body: 'novo body' },
    });
  });
});

// ── deleteTemplate ───────────────────────────────────────────────────────────────

describe('MessagingController.deleteTemplate', () => {
  let mockTemplateRepo: { findAll: jest.Mock; upsert: jest.Mock; deactivate: jest.Mock };
  let controller: MessagingController;

  beforeEach(() => {
    jest.clearAllMocks();
    mockTemplateRepo = { findAll: jest.fn(), upsert: jest.fn(), deactivate: jest.fn() };
    controller = new MessagingController({} as any, mockTemplateRepo as any);
  });

  it('template não encontrado → 404', async () => {
    mockTemplateRepo.deactivate.mockResolvedValueOnce(false);
    const res = mockRes();
    await controller.deleteTemplate(makeReq({}, { params: { slug: 'nao-existe' } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect((res.json as jest.Mock).mock.calls[0][0]).toEqual({ error: 'Template não encontrado' });
  });

  it('desativado com sucesso → 200', async () => {
    mockTemplateRepo.deactivate.mockResolvedValueOnce(true);
    const res = mockRes();
    await controller.deleteTemplate(makeReq({}, { params: { slug: 'x' } }), res);

    expect(mockTemplateRepo.deactivate).toHaveBeenCalledWith('x');
    expect(res.status).toHaveBeenCalledWith(200);
    expect((res.json as jest.Mock).mock.calls[0][0]).toEqual({ success: true });
  });
});

// ── bulkDispatchIncomplete ───────────────────────────────────────────────────────

describe('MessagingController.bulkDispatchIncomplete', () => {
  let controller: MessagingController;

  beforeEach(() => {
    jest.clearAllMocks();
    const { DatabaseConnection } = jest.requireMock('@shared/database/DatabaseConnection');
    DatabaseConnection.getInstance.mockReturnValue({ getPool: () => ({ query: jest.fn() }) });
    controller = new MessagingController({} as any, {} as any);
  });

  it('sucesso → 200, passa triggeredBy do auth context e dryRun/limit default', async () => {
    mockBulkExecute.mockResolvedValueOnce({
      isFailure: false,
      getValue: () => ({ sent: 3, skipped: 0 }),
    });

    const res = mockRes();
    await controller.bulkDispatchIncomplete(makeReq({}, { query: {} }), res);

    expect(mockBulkExecute).toHaveBeenCalledWith('user-abc-123', { dryRun: false, limit: undefined });
    expect(res.status).toHaveBeenCalledWith(200);
    expect((res.json as jest.Mock).mock.calls[0][0]).toEqual({ success: true, data: { sent: 3, skipped: 0 } });
  });

  it('?dryRun=true&limit=5 → repassa dryRun/limit ao use case', async () => {
    mockBulkExecute.mockResolvedValueOnce({ isFailure: false, getValue: () => ({ wouldSend: 5 }) });

    const res = mockRes();
    await controller.bulkDispatchIncomplete(makeReq({}, { query: { dryRun: 'true', limit: '5' } }), res);

    expect(mockBulkExecute).toHaveBeenCalledWith('user-abc-123', { dryRun: true, limit: 5 });
  });

  it('limit inválido (não numérico) → undefined é repassado', async () => {
    mockBulkExecute.mockResolvedValueOnce({ isFailure: false, getValue: () => ({}) });

    const res = mockRes();
    await controller.bulkDispatchIncomplete(makeReq({}, { query: { limit: 'abc' } }), res);

    expect(mockBulkExecute).toHaveBeenCalledWith('user-abc-123', { dryRun: false, limit: undefined });
  });

  it('use case falha → 500 com error', async () => {
    mockBulkExecute.mockResolvedValueOnce({ isFailure: true, error: 'boom' });

    const res = mockRes();
    await controller.bulkDispatchIncomplete(makeReq({}, { query: {} }), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect((res.json as jest.Mock).mock.calls[0][0]).toEqual({ error: 'boom' });
  });

  it('AuthMiddleware sem principal.id → triggeredBy cai no fallback "unknown"', async () => {
    const { AuthMiddleware } = jest.requireMock('@modules/identity');
    AuthMiddleware.getAuthContext.mockReturnValueOnce(undefined);
    mockBulkExecute.mockResolvedValueOnce({ isFailure: false, getValue: () => ({}) });

    const res = mockRes();
    await controller.bulkDispatchIncomplete(makeReq({}, { query: {} }), res);

    expect(mockBulkExecute).toHaveBeenCalledWith('unknown', { dryRun: false, limit: undefined });
  });
});
