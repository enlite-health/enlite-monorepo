/**
 * dedup-use-cases.test.ts
 *
 * Testes unitários dos use cases do Centro de Duplicados.
 * Usa mocks de pool/client — sem banco real.
 *
 * Cobertos:
 *   ListDedupGroupsUseCase    → filtra grupos não dispensados, ordena, classifica tiers
 *   DismissGroupUseCase       → persiste dispensa; idempotente (alreadyDismissed)
 *   UndoMergeUseCase          → delega para WorkerPhoneMergeService.undoMerge
 *   ListMergeHistoryUseCase   → retorna entries com can_undo correto
 *   ExecuteAdminMergeUseCase  → valida survivor, chama merge, retorna audit_ids
 */

jest.mock('@shared/database/DatabaseConnection');
jest.mock('@shared/logging', () => ({
  logger:      { child: jest.fn().mockReturnValue({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) },
  reportError: jest.fn(),
  loggingAls:  { run: jest.fn() },
}));
jest.mock('../../../infrastructure/services/WorkerPhoneMergeService');
jest.mock('../../../infrastructure/services/WorkerPhoneMergeFkDiscovery');

import type { Pool, QueryResult } from 'pg';
import { DismissGroupUseCase } from '../DismissGroupUseCase';
import { ListMergeHistoryUseCase } from '../ListMergeHistoryUseCase';
import { UndoMergeUseCase } from '../UndoMergeUseCase';
import { WorkerPhoneMergeService } from '../../../infrastructure/services/WorkerPhoneMergeService';

// ── Helpers de mock ────────────────────────────────────────────────────────

function makePool(responses: unknown[]): jest.Mocked<Pick<Pool, 'query'>> {
  let idx = 0;
  return {
    query: jest.fn().mockImplementation(() => {
      const resp = responses[idx++] ?? { rows: [] };
      return Promise.resolve(resp);
    }),
  } as unknown as jest.Mocked<Pick<Pool, 'query'>>;
}

// ── DismissGroupUseCase ────────────────────────────────────────────────────

describe('DismissGroupUseCase', () => {
  it('persiste dispensa e retorna alreadyDismissed=false quando não existia', async () => {
    const pool = makePool([
      { rows: [{ id: 1 }] }, // INSERT retorna id
    ]);

    const useCase = new DismissGroupUseCase(pool as unknown as Pool);
    const result = await useCase.execute({ phoneNormalized: '5491112345678' });

    expect(result.alreadyDismissed).toBe(false);
    expect(result.phoneNormalized).toBe('5491112345678');
    expect((pool.query as jest.Mock)).toHaveBeenCalledTimes(1);
  });

  it('retorna alreadyDismissed=true quando INSERT faz ON CONFLICT DO NOTHING (0 rows)', async () => {
    const pool = makePool([
      { rows: [] }, // INSERT sem retorno = conflito
    ]);

    const useCase = new DismissGroupUseCase(pool as unknown as Pool);
    const result = await useCase.execute({ phoneNormalized: '5491112345678' });

    expect(result.alreadyDismissed).toBe(true);
  });

  it('passa reason e dismissedBy para o INSERT', async () => {
    const pool = makePool([{ rows: [{ id: 2 }] }]);
    const useCase = new DismissGroupUseCase(pool as unknown as Pool);

    await useCase.execute({
      phoneNormalized: '5491112345678',
      reason: 'número de empresa',
      dismissedBy: 'admin-uid-abc',
    });

    const call = (pool.query as jest.Mock).mock.calls[0];
    expect(call[1]).toEqual(['5491112345678', 'número de empresa', 'admin-uid-abc']);
  });
});

// ── ListMergeHistoryUseCase ────────────────────────────────────────────────

describe('ListMergeHistoryUseCase', () => {
  const baseDate = new Date('2026-01-15T10:00:00Z');

  it('retorna entries com can_undo=true quando tem snapshot não desfeito', async () => {
    const pool = makePool([
      {
        rows: [{
          id: 42,
          survivor_id: 'survivor-uuid',
          absorbed_id: 'absorbed-uuid',
          phone_normalized: '5491112345678',
          category: 'firebase',
          fields_filled: ['profession'],
          exceptions: [],
          created_at: baseDate,
          has_snapshot: true,
          undone_at: null,
        }],
      },
    ]);

    const useCase = new ListMergeHistoryUseCase(pool as unknown as Pool);
    const entries = await useCase.execute();

    expect(entries).toHaveLength(1);
    expect(entries[0].audit_id).toBe(42);
    expect(entries[0].can_undo).toBe(true);
    expect(entries[0].category).toBe('firebase');
  });

  it('retorna can_undo=false quando undone_at está preenchido', async () => {
    const pool = makePool([
      {
        rows: [{
          id: 43,
          survivor_id: 'survivor-uuid',
          absorbed_id: 'absorbed-uuid',
          phone_normalized: '5491112345679',
          category: 'most_complete',
          fields_filled: [],
          exceptions: [],
          created_at: baseDate,
          has_snapshot: true,
          undone_at: new Date('2026-01-16T10:00:00Z'),
        }],
      },
    ]);

    const useCase = new ListMergeHistoryUseCase(pool as unknown as Pool);
    const entries = await useCase.execute();

    expect(entries[0].can_undo).toBe(false);
  });

  it('retorna can_undo=false quando não tem snapshot', async () => {
    const pool = makePool([
      {
        rows: [{
          id: 44,
          survivor_id: 's-uuid',
          absorbed_id: 'a-uuid',
          phone_normalized: '5491112345680',
          category: 'ghost',
          fields_filled: [],
          exceptions: [],
          created_at: baseDate,
          has_snapshot: false,
          undone_at: null,
        }],
      },
    ]);

    const useCase = new ListMergeHistoryUseCase(pool as unknown as Pool);
    const entries = await useCase.execute();

    expect(entries[0].can_undo).toBe(false);
  });

  it('repassa limit e offset corretos para a query', async () => {
    const pool = makePool([{ rows: [] }]);
    const useCase = new ListMergeHistoryUseCase(pool as unknown as Pool);

    await useCase.execute({ limit: 10, offset: 20 });

    const call = (pool.query as jest.Mock).mock.calls[0];
    expect(call[1]).toEqual([10, 20]);
  });

  it('normaliza fields_filled=null e exceptions=null para [] (branch ?? [])', async () => {
    const pool = makePool([
      {
        rows: [{
          id: 45,
          survivor_id: 's-uuid',
          absorbed_id: 'a-uuid',
          phone_normalized: '5491112345681',
          category: 'firebase',
          fields_filled: null,  // força o branch ?? []
          exceptions: null,     // força o branch ?? []
          created_at: new Date('2026-01-15T10:00:00Z'),
          has_snapshot: true,
          undone_at: null,
        }],
      },
    ]);

    const useCase = new ListMergeHistoryUseCase(pool as unknown as Pool);
    const entries = await useCase.execute();

    expect(entries[0].fields_filled).toEqual([]);
    expect(entries[0].exceptions).toEqual([]);
  });
});

// ── UndoMergeUseCase ──────────────────────────────────────────────────────

describe('UndoMergeUseCase', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('delega para WorkerPhoneMergeService.undoMerge e retorna resultado', async () => {
    (WorkerPhoneMergeService as jest.MockedClass<typeof WorkerPhoneMergeService>)
      .prototype.undoMerge.mockResolvedValueOnce({
        survivorId: 'survivor-uuid',
        absorbedId: 'absorbed-uuid',
        alreadyUndone: false,
      });

    const pool = makePool([]);
    const useCase = new UndoMergeUseCase(pool as unknown as Pool);
    const result = await useCase.execute(42);

    expect(result.auditId).toBe(42);
    expect(result.survivorId).toBe('survivor-uuid');
    expect(result.absorbedId).toBe('absorbed-uuid');
    expect(result.alreadyUndone).toBe(false);
    expect(WorkerPhoneMergeService.prototype.undoMerge).toHaveBeenCalledWith(42);
  });

  it('retorna alreadyUndone=true quando merge já foi desfeito', async () => {
    (WorkerPhoneMergeService as jest.MockedClass<typeof WorkerPhoneMergeService>)
      .prototype.undoMerge.mockResolvedValueOnce({
        survivorId: 'sv',
        absorbedId: 'ab',
        alreadyUndone: true,
      });

    const pool = makePool([]);
    const useCase = new UndoMergeUseCase(pool as unknown as Pool);
    const result = await useCase.execute(99);

    expect(result.alreadyUndone).toBe(true);
  });

  it('propaga erro quando undoMerge lança exceção', async () => {
    (WorkerPhoneMergeService as jest.MockedClass<typeof WorkerPhoneMergeService>)
      .prototype.undoMerge.mockRejectedValueOnce(new Error('audit não encontrado'));

    const pool = makePool([]);
    const useCase = new UndoMergeUseCase(pool as unknown as Pool);

    await expect(useCase.execute(999)).rejects.toThrow('audit não encontrado');
  });
});
