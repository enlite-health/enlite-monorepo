/**
 * AdminDedupController.test.ts
 *
 * Testes unitários do AdminDedupController.
 * Usa mocks de todos os use cases + DatabaseConnection.
 *
 * Cobre todos os métodos:
 *   listGroups      → 200 + 500
 *   getGroupDetail  → 200 + 404 + 400 (sem param) + 500
 *   executeMerge    → 200 + 400 (Zod) + 500
 *   dismissGroup    → 200 + 400 (Zod) + 500
 *   undoMerge       → 200 + 400 (auditId inválido) + 500
 *   listHistory     → 200 + 400 (Zod) + 500
 */

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({}),
    }),
  },
}));

jest.mock('@shared/logging', () => ({
  logger: { child: jest.fn().mockReturnValue({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) },
  reportError: jest.fn(),
}));

jest.mock('../../../../application/dedup/ListDedupGroupsUseCase');
jest.mock('../../../../application/dedup/GetDedupGroupDetailUseCase');
jest.mock('../../../../application/dedup/ExecuteAdminMergeUseCase');
jest.mock('../../../../application/dedup/DismissGroupUseCase');
jest.mock('../../../../application/dedup/UndoMergeUseCase');
jest.mock('../../../../application/dedup/ListMergeHistoryUseCase');
jest.mock('../../../../application/dedup/ListImportedDedupGroupsUseCase');

import type { Request, Response } from 'express';
import { AdminDedupController } from '../AdminDedupController';
import { ListDedupGroupsUseCase }     from '../../../../application/dedup/ListDedupGroupsUseCase';
import { GetDedupGroupDetailUseCase } from '../../../../application/dedup/GetDedupGroupDetailUseCase';
import { ExecuteAdminMergeUseCase }   from '../../../../application/dedup/ExecuteAdminMergeUseCase';
import { DismissGroupUseCase }        from '../../../../application/dedup/DismissGroupUseCase';
import { UndoMergeUseCase }           from '../../../../application/dedup/UndoMergeUseCase';
import { ListMergeHistoryUseCase }    from '../../../../application/dedup/ListMergeHistoryUseCase';
import { ListImportedDedupGroupsUseCase } from '../../../../application/dedup/ListImportedDedupGroupsUseCase';

// ── Helpers de mock ───────────────────────────────────────────────────────────

function makeRes(): jest.Mocked<Pick<Response, 'status' | 'json'>> {
  const res = {
    status: jest.fn(),
    json: jest.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as unknown as jest.Mocked<Pick<Response, 'status' | 'json'>>;
}

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    params: {},
    query: {},
    body: {},
    user: {},
    ...overrides,
  } as unknown as Request;
}

const SURVIVOR_ID = 'eeeeeeee-0000-0000-0000-000000000001';
const ABSORBED_ID = 'eeeeeeee-0000-0000-0000-000000000002';
const PHONE_NORM  = '5491155550001';

beforeEach(() => {
  jest.clearAllMocks();
});

// ── listGroups ────────────────────────────────────────────────────────────────

describe('AdminDedupController.listGroups', () => {
  it('200 com lista de grupos', async () => {
    const groups = [{ phone_normalized: PHONE_NORM, accounts: [], survivor_suggested_id: null, survivor_reason: '' }];
    (ListDedupGroupsUseCase as jest.MockedClass<typeof ListDedupGroupsUseCase>)
      .prototype.execute.mockResolvedValueOnce(groups);

    const controller = new AdminDedupController();
    const req = makeReq();
    const res = makeRes();

    await controller.listGroups(req as Request, res as unknown as Response);

    expect(res.json).toHaveBeenCalledWith({ success: true, data: groups, total: 1 });
  });

  it('500 quando use case lança erro', async () => {
    (ListDedupGroupsUseCase as jest.MockedClass<typeof ListDedupGroupsUseCase>)
      .prototype.execute.mockRejectedValueOnce(new Error('db failure'));

    const controller = new AdminDedupController();
    const req = makeReq();
    const res = makeRes();

    await controller.listGroups(req as Request, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Erro interno' });
  });
});

// ── getGroupDetail ────────────────────────────────────────────────────────────

describe('AdminDedupController.getGroupDetail', () => {
  it('200 com detalhe do grupo', async () => {
    const detail = { phone_normalized: PHONE_NORM, accounts: [], survivor_suggested: '', reparent_preview: [], field_comparisons: [] };
    (GetDedupGroupDetailUseCase as jest.MockedClass<typeof GetDedupGroupDetailUseCase>)
      .prototype.execute.mockResolvedValueOnce(detail);

    const controller = new AdminDedupController();
    const req = makeReq({ params: { phoneNormalized: PHONE_NORM } });
    const res = makeRes();

    await controller.getGroupDetail(req as Request, res as unknown as Response);

    expect(res.json).toHaveBeenCalledWith({ success: true, data: detail });
  });

  it('404 quando use case retorna null', async () => {
    (GetDedupGroupDetailUseCase as jest.MockedClass<typeof GetDedupGroupDetailUseCase>)
      .prototype.execute.mockResolvedValueOnce(null);

    const controller = new AdminDedupController();
    const req = makeReq({ params: { phoneNormalized: PHONE_NORM } });
    const res = makeRes();

    await controller.getGroupDetail(req as Request, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Grupo não encontrado' });
  });

  it('400 quando phoneNormalized não fornecido', async () => {
    const controller = new AdminDedupController();
    const req = makeReq({ params: {} });
    const res = makeRes();

    await controller.getGroupDetail(req as Request, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'phoneNormalized é obrigatório' });
  });

  it('500 quando use case lança erro', async () => {
    (GetDedupGroupDetailUseCase as jest.MockedClass<typeof GetDedupGroupDetailUseCase>)
      .prototype.execute.mockRejectedValueOnce(new Error('unexpected'));

    const controller = new AdminDedupController();
    const req = makeReq({ params: { phoneNormalized: PHONE_NORM } });
    const res = makeRes();

    await controller.getGroupDetail(req as Request, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ── executeMerge ──────────────────────────────────────────────────────────────

describe('AdminDedupController.executeMerge', () => {
  it('200 com resultado do merge', async () => {
    const mergeResult = { audit_ids: [42], survivor_id: SURVIVOR_ID, absorbed_ids: [ABSORBED_ID] };
    (ExecuteAdminMergeUseCase as jest.MockedClass<typeof ExecuteAdminMergeUseCase>)
      .prototype.execute.mockResolvedValueOnce(mergeResult);

    const controller = new AdminDedupController();
    const req = makeReq({
      body: { survivorId: SURVIVOR_ID, absorbedIds: [ABSORBED_ID] },
      user: { uid: 'admin-uid-123' },
    } as unknown as Partial<Request>);
    const res = makeRes();

    await controller.executeMerge(req as Request, res as unknown as Response);

    expect(res.json).toHaveBeenCalledWith({ success: true, data: mergeResult });
  });

  it('400 com survivorId inválido (não UUID)', async () => {
    const controller = new AdminDedupController();
    const req = makeReq({
      body: { survivorId: 'nao-e-uuid', absorbedIds: [ABSORBED_ID] },
    });
    const res = makeRes();

    await controller.executeMerge(req as Request, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(400);
    const call = (res.json as jest.Mock).mock.calls[0][0];
    expect(call.success).toBe(false);
    expect(call.error).toBeDefined();
  });

  it('400 com absorbedIds vazio', async () => {
    const controller = new AdminDedupController();
    const req = makeReq({
      body: { survivorId: SURVIVOR_ID, absorbedIds: [] },
    });
    const res = makeRes();

    await controller.executeMerge(req as Request, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('400 sem body', async () => {
    const controller = new AdminDedupController();
    const req = makeReq({ body: {} });
    const res = makeRes();

    await controller.executeMerge(req as Request, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('500 quando use case lança erro', async () => {
    (ExecuteAdminMergeUseCase as jest.MockedClass<typeof ExecuteAdminMergeUseCase>)
      .prototype.execute.mockRejectedValueOnce(new Error('merge failed'));

    const controller = new AdminDedupController();
    const req = makeReq({
      body: { survivorId: SURVIVOR_ID, absorbedIds: [ABSORBED_ID] },
    });
    const res = makeRes();

    await controller.executeMerge(req as Request, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('passa fieldChoices para use case quando fornecido', async () => {
    const mergeResult = { audit_ids: [55], survivor_id: SURVIVOR_ID, absorbed_ids: [ABSORBED_ID] };
    (ExecuteAdminMergeUseCase as jest.MockedClass<typeof ExecuteAdminMergeUseCase>)
      .prototype.execute.mockResolvedValueOnce(mergeResult);

    const controller = new AdminDedupController();
    const fieldChoices = { profession: `absorbed:${ABSORBED_ID}` };
    const req = makeReq({
      body: { survivorId: SURVIVOR_ID, absorbedIds: [ABSORBED_ID], fieldChoices },
    });
    const res = makeRes();

    await controller.executeMerge(req as Request, res as unknown as Response);

    const callArgs = (ExecuteAdminMergeUseCase.prototype.execute as jest.Mock).mock.calls[0][0];
    expect(callArgs.fieldChoices).toEqual(fieldChoices);
  });
});

// ── dismissGroup ──────────────────────────────────────────────────────────────

describe('AdminDedupController.dismissGroup', () => {
  it('200 com resultado da dispensa', async () => {
    const dismissResult = { alreadyDismissed: false, phoneNormalized: PHONE_NORM };
    (DismissGroupUseCase as jest.MockedClass<typeof DismissGroupUseCase>)
      .prototype.execute.mockResolvedValueOnce(dismissResult);

    const controller = new AdminDedupController();
    const req = makeReq({
      body: { phoneNormalized: PHONE_NORM, reason: 'empresa' },
    });
    const res = makeRes();

    await controller.dismissGroup(req as Request, res as unknown as Response);

    expect(res.json).toHaveBeenCalledWith({ success: true, data: dismissResult });
  });

  it('400 sem phoneNormalized', async () => {
    const controller = new AdminDedupController();
    const req = makeReq({ body: {} });
    const res = makeRes();

    await controller.dismissGroup(req as Request, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('500 quando use case lança erro', async () => {
    (DismissGroupUseCase as jest.MockedClass<typeof DismissGroupUseCase>)
      .prototype.execute.mockRejectedValueOnce(new Error('db down'));

    const controller = new AdminDedupController();
    const req = makeReq({ body: { phoneNormalized: PHONE_NORM } });
    const res = makeRes();

    await controller.dismissGroup(req as Request, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ── undoMerge ─────────────────────────────────────────────────────────────────

describe('AdminDedupController.undoMerge', () => {
  it('200 com resultado do undo', async () => {
    const undoResult = { auditId: 42, survivorId: SURVIVOR_ID, absorbedId: ABSORBED_ID, alreadyUndone: false };
    (UndoMergeUseCase as jest.MockedClass<typeof UndoMergeUseCase>)
      .prototype.execute.mockResolvedValueOnce(undoResult);

    const controller = new AdminDedupController();
    const req = makeReq({ params: { auditId: '42' } });
    const res = makeRes();

    await controller.undoMerge(req as Request, res as unknown as Response);

    expect(res.json).toHaveBeenCalledWith({ success: true, data: undoResult });
  });

  it('400 com auditId não numérico', async () => {
    const controller = new AdminDedupController();
    const req = makeReq({ params: { auditId: 'abc' } });
    const res = makeRes();

    await controller.undoMerge(req as Request, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'auditId inválido' });
  });

  it('400 com auditId = 0 (não positivo)', async () => {
    const controller = new AdminDedupController();
    const req = makeReq({ params: { auditId: '0' } });
    const res = makeRes();

    await controller.undoMerge(req as Request, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('400 com auditId negativo', async () => {
    const controller = new AdminDedupController();
    const req = makeReq({ params: { auditId: '-5' } });
    const res = makeRes();

    await controller.undoMerge(req as Request, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('500 quando use case lança erro', async () => {
    (UndoMergeUseCase as jest.MockedClass<typeof UndoMergeUseCase>)
      .prototype.execute.mockRejectedValueOnce(new Error('audit not found'));

    const controller = new AdminDedupController();
    const req = makeReq({ params: { auditId: '99' } });
    const res = makeRes();

    await controller.undoMerge(req as Request, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ── listHistory ───────────────────────────────────────────────────────────────

describe('AdminDedupController.listHistory', () => {
  it('200 com lista de entries', async () => {
    const entries = [
      {
        audit_id: 1,
        survivor_id: SURVIVOR_ID,
        absorbed_id: ABSORBED_ID,
        phone_normalized: PHONE_NORM,
        category: 'firebase',
        fields_filled: [],
        exceptions: [],
        created_at: '2026-01-01T00:00:00.000Z',
        can_undo: true,
      },
    ];
    (ListMergeHistoryUseCase as jest.MockedClass<typeof ListMergeHistoryUseCase>)
      .prototype.execute.mockResolvedValueOnce(entries);

    const controller = new AdminDedupController();
    const req = makeReq({ query: { limit: '10', offset: '0' } });
    const res = makeRes();

    await controller.listHistory(req as Request, res as unknown as Response);

    expect(res.json).toHaveBeenCalledWith({ success: true, data: entries, total: 1 });
  });

  it('200 com defaults limit=50 offset=0 quando query vazia', async () => {
    (ListMergeHistoryUseCase as jest.MockedClass<typeof ListMergeHistoryUseCase>)
      .prototype.execute.mockResolvedValueOnce([]);

    const controller = new AdminDedupController();
    const req = makeReq({ query: {} });
    const res = makeRes();

    await controller.listHistory(req as Request, res as unknown as Response);

    const callArgs = (ListMergeHistoryUseCase.prototype.execute as jest.Mock).mock.calls[0][0];
    expect(callArgs.limit).toBe(50);
    expect(callArgs.offset).toBe(0);
  });

  it('400 com limit > 200', async () => {
    const controller = new AdminDedupController();
    const req = makeReq({ query: { limit: '500' } });
    const res = makeRes();

    await controller.listHistory(req as Request, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('400 com limit não numérico (NaN após coerce)', async () => {
    const controller = new AdminDedupController();
    const req = makeReq({ query: { limit: 'invalid' } });
    const res = makeRes();

    await controller.listHistory(req as Request, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('500 quando use case lança erro', async () => {
    (ListMergeHistoryUseCase as jest.MockedClass<typeof ListMergeHistoryUseCase>)
      .prototype.execute.mockRejectedValueOnce(new Error('query failed'));

    const controller = new AdminDedupController();
    const req = makeReq({ query: {} });
    const res = makeRes();

    await controller.listHistory(req as Request, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ── listImportedGroups ────────────────────────────────────────────────────────

describe('AdminDedupController.listImportedGroups', () => {
  const importedGroup = {
    name_trgm_bidx_key: 'hex_key_abc',
    accounts: [],
    match_type: 'name' as const,
    confidence: 'name_fuzzy' as const,
    survivor_suggested_id: 'eeeeeeee-0000-0000-0000-000000000001',
    survivor_reason: 'real_account_absorbs_imported',
    has_real: true,
  };

  it('200 com lista de grupos importados (sem query)', async () => {
    (ListImportedDedupGroupsUseCase as jest.MockedClass<typeof ListImportedDedupGroupsUseCase>)
      .prototype.execute.mockResolvedValueOnce([importedGroup]);

    const controller = new AdminDedupController();
    const req = makeReq({ query: {} });
    const res = makeRes();

    await controller.listImportedGroups(req as Request, res as unknown as Response);

    expect(res.json).toHaveBeenCalledWith({ success: true, data: [importedGroup], total: 1 });
  });

  it('200 com ?onlyWithReal=true passado ao use case', async () => {
    (ListImportedDedupGroupsUseCase as jest.MockedClass<typeof ListImportedDedupGroupsUseCase>)
      .prototype.execute.mockResolvedValueOnce([importedGroup]);

    const controller = new AdminDedupController();
    const req = makeReq({ query: { onlyWithReal: 'true' } });
    const res = makeRes();

    await controller.listImportedGroups(req as Request, res as unknown as Response);

    const callArgs = (ListImportedDedupGroupsUseCase.prototype.execute as jest.Mock).mock.calls[0][0];
    expect(callArgs.onlyWithReal).toBe(true);
  });

  it('200 com ?onlyWithReal=false passado ao use case', async () => {
    (ListImportedDedupGroupsUseCase as jest.MockedClass<typeof ListImportedDedupGroupsUseCase>)
      .prototype.execute.mockResolvedValueOnce([]);

    const controller = new AdminDedupController();
    const req = makeReq({ query: { onlyWithReal: 'false' } });
    const res = makeRes();

    await controller.listImportedGroups(req as Request, res as unknown as Response);

    const callArgs = (ListImportedDedupGroupsUseCase.prototype.execute as jest.Mock).mock.calls[0][0];
    expect(callArgs.onlyWithReal).toBe(false);
  });

  it('200 com query ausente → onlyWithReal=false por default', async () => {
    (ListImportedDedupGroupsUseCase as jest.MockedClass<typeof ListImportedDedupGroupsUseCase>)
      .prototype.execute.mockResolvedValueOnce([]);

    const controller = new AdminDedupController();
    const req = makeReq({ query: {} });
    const res = makeRes();

    await controller.listImportedGroups(req as Request, res as unknown as Response);

    const callArgs = (ListImportedDedupGroupsUseCase.prototype.execute as jest.Mock).mock.calls[0][0];
    expect(callArgs.onlyWithReal).toBe(false);
  });

  it('500 quando use case lança erro', async () => {
    (ListImportedDedupGroupsUseCase as jest.MockedClass<typeof ListImportedDedupGroupsUseCase>)
      .prototype.execute.mockRejectedValueOnce(new Error('db failure'));

    const controller = new AdminDedupController();
    const req = makeReq({ query: {} });
    const res = makeRes();

    await controller.listImportedGroups(req as Request, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Erro interno' });
  });
});

// ── handleError — branch non-Error (linha 180) ───────────────────────────────

describe('AdminDedupController — handleError com não-Error (branch linha 180)', () => {
  it('wraps string em Error quando thrown não é instância de Error', async () => {
    // Lança uma string (não Error) → deve criar new Error(String(err))
    (ListDedupGroupsUseCase as jest.MockedClass<typeof ListDedupGroupsUseCase>)
      .prototype.execute.mockRejectedValueOnce('plain string error' as unknown as Error);

    const controller = new AdminDedupController();
    const req = makeReq();
    const res = makeRes();

    await controller.listGroups(req as Request, res as unknown as Response);

    // Deve retornar 500 mesmo com erro não-Error
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Erro interno' });
  });
});
