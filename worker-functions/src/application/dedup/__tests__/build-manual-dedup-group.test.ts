/**
 * build-manual-dedup-group.test.ts
 *
 * Testes unitários de BuildManualDedupGroupUseCase.
 * Pool mockado (sem banco real).
 *
 * Cobre:
 *   1. 2 contas reais → conflict_multiple_real_accounts, survivor_suggested_id=null
 *   2. 1 real + 1 importado → real_account_absorbs_imported, survivor = real
 *   3. ID inexistente → ManualDedupValidationError com mensagem clara
 *   4. Worker já mergeado → ManualDedupValidationError com mensagem clara
 *   5. Shape de ManualDedupAccount: name, phone_normalized, login_real, is_imported
 *   6. 2 importados sem real → most_complete_imported
 */

jest.mock('@shared/logging', () => ({
  logger: {
    child: jest.fn().mockReturnValue({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }),
  },
  reportError: jest.fn(),
}));

jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({
    decrypt: jest.fn().mockResolvedValue(''),
  })),
}));

jest.mock('../loadWorkerDisplayNames', () => ({
  loadWorkerDisplayNames: jest.fn(),
}));

import type { Pool } from 'pg';
import {
  BuildManualDedupGroupUseCase,
  ManualDedupValidationError,
} from '../BuildManualDedupGroupUseCase';
import { loadWorkerDisplayNames } from '../loadWorkerDisplayNames';

// ── IDs ───────────────────────────────────────────────────────────────────────

const ID_REAL1  = 'aaaaaaaa-1111-0000-0000-000000000001';
const ID_REAL2  = 'aaaaaaaa-2222-0000-0000-000000000002';
const ID_IMP1   = 'aaaaaaaa-3333-0000-0000-000000000003';
const ID_IMP2   = 'aaaaaaaa-4444-0000-0000-000000000004';
const BASE_DATE = new Date('2026-01-01T00:00:00Z');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRow(overrides: Partial<{
  id: string;
  email: string;
  auth_uid: string | null;
  status: string;
  completeness_score: number;
  document_count: number;
  wja_count: number;
  encuadres_count: number;
  phone_normalized: string | null;
  merged_into_id: string | null;
  document_number_encrypted: string | null;
  data_sources: string[] | null;
  created_at: Date;
  updated_at: Date;
}> = {}): Record<string, unknown> {
  return {
    id: ID_REAL1,
    email: 'worker@example.com',
    auth_uid: 'FirebaseReal_abc',
    status: 'REGISTERED',
    created_at: BASE_DATE,
    updated_at: BASE_DATE,
    completeness_score: 3,
    document_count: 1,
    wja_count: 0,
    encuadres_count: 0,
    document_number_encrypted: null,
    data_sources: null,
    phone_normalized: null,
    merged_into_id: null,
    ...overrides,
  };
}

function makePool(rows: unknown[]): jest.Mocked<Pick<Pool, 'query'>> {
  return {
    query: jest.fn().mockResolvedValue({ rows }),
  } as unknown as jest.Mocked<Pick<Pool, 'query'>>;
}

const mockLoadNames = loadWorkerDisplayNames as jest.MockedFunction<typeof loadWorkerDisplayNames>;

beforeEach(() => {
  jest.clearAllMocks();
});

// ── 1. 2 contas reais → conflict ──────────────────────────────────────────────

describe('BuildManualDedupGroupUseCase — 2 reais → conflict', () => {
  it('survivor_suggested_id=null, survivor_reason=conflict_multiple_real_accounts', async () => {
    const rows = [
      makeRow({ id: ID_REAL1, email: 'real1@example.com', auth_uid: 'FirebaseReal_aaa' }),
      makeRow({ id: ID_REAL2, email: 'real2@example.com', auth_uid: 'FirebaseReal_bbb' }),
    ];
    const pool = makePool(rows);
    mockLoadNames.mockResolvedValueOnce(new Map([
      [ID_REAL1, 'Ana García'],
      [ID_REAL2, 'Ana García'],
    ]));

    const useCase = new BuildManualDedupGroupUseCase(pool as unknown as Pool);
    const result = await useCase.execute([ID_REAL1, ID_REAL2]);

    expect(result.survivor_suggested_id).toBeNull();
    expect(result.survivor_reason).toBe('conflict_multiple_real_accounts');
    expect(result.accounts).toHaveLength(2);
  });
});

// ── 2. 1 real + 1 importado → real_account_absorbs_imported ──────────────────

describe('BuildManualDedupGroupUseCase — 1 real + 1 importado', () => {
  it('survivor = real, reason = real_account_absorbs_imported', async () => {
    const rows = [
      makeRow({ id: ID_REAL1, email: 'real@example.com',   auth_uid: 'FirebaseReal_abc' }),
      makeRow({ id: ID_IMP1,  email: 'ghost@enlite.import', auth_uid: 'base1import_xyz' }),
    ];
    const pool = makePool(rows);
    mockLoadNames.mockResolvedValueOnce(new Map([
      [ID_REAL1, 'María García'],
      [ID_IMP1,  '(importado)'],
    ]));

    const useCase = new BuildManualDedupGroupUseCase(pool as unknown as Pool);
    const result = await useCase.execute([ID_REAL1, ID_IMP1]);

    expect(result.survivor_suggested_id).toBe(ID_REAL1);
    expect(result.survivor_reason).toBe('real_account_absorbs_imported');
  });

  it('accounts têm name, phone_normalized, login_real, is_imported corretos', async () => {
    const rows = [
      makeRow({
        id: ID_REAL1,
        email: 'real@example.com',
        auth_uid: 'FirebaseReal_abc',
        phone_normalized: '549111222333',
      }),
      makeRow({
        id: ID_IMP1,
        email: 'ghost@enlite.import',
        auth_uid: 'base1import_xyz',
        phone_normalized: null,
      }),
    ];
    const pool = makePool(rows);
    mockLoadNames.mockResolvedValueOnce(new Map([
      [ID_REAL1, 'María García'],
      [ID_IMP1,  '(importado)'],
    ]));

    const useCase = new BuildManualDedupGroupUseCase(pool as unknown as Pool);
    const result = await useCase.execute([ID_REAL1, ID_IMP1]);

    const realAcc = result.accounts.find(a => a.id === ID_REAL1);
    const impAcc  = result.accounts.find(a => a.id === ID_IMP1);

    expect(realAcc?.name).toBe('María García');
    expect(realAcc?.phone_normalized).toBe('549111222333');
    expect(realAcc?.login_real).toBe(true);
    expect(realAcc?.is_imported).toBe(false);
    expect(realAcc?.tier).toBe(1);

    expect(impAcc?.name).toBe('(importado)');
    expect(impAcc?.phone_normalized).toBeNull();
    expect(impAcc?.login_real).toBe(false);
    expect(impAcc?.is_imported).toBe(true);
    expect(impAcc?.tier).toBe(3);
  });
});

// ── 3. ID inexistente → ManualDedupValidationError ───────────────────────────

describe('BuildManualDedupGroupUseCase — id inexistente', () => {
  it('lança ManualDedupValidationError com lista dos IDs não encontrados', async () => {
    const MISSING_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    // Pool só retorna 1 dos 2 IDs (ID_REAL1 existe, MISSING_ID não)
    const pool = makePool([makeRow({ id: ID_REAL1 })]);

    const useCase = new BuildManualDedupGroupUseCase(pool as unknown as Pool);

    await expect(useCase.execute([ID_REAL1, MISSING_ID])).rejects.toThrow(
      ManualDedupValidationError,
    );
    await expect(useCase.execute([ID_REAL1, MISSING_ID])).rejects.toThrow(
      MISSING_ID,
    );
  });
});

// ── 4. Worker já mergeado → ManualDedupValidationError ───────────────────────

describe('BuildManualDedupGroupUseCase — worker já mergeado', () => {
  it('lança ManualDedupValidationError informando o id absorvido', async () => {
    const rows = [
      makeRow({ id: ID_REAL1, merged_into_id: null }),
      makeRow({ id: ID_IMP1,  merged_into_id: ID_REAL1 }),  // já absorvido
    ];
    const pool = makePool(rows);

    const useCase = new BuildManualDedupGroupUseCase(pool as unknown as Pool);

    await expect(useCase.execute([ID_REAL1, ID_IMP1])).rejects.toThrow(
      ManualDedupValidationError,
    );
    await expect(useCase.execute([ID_REAL1, ID_IMP1])).rejects.toThrow(
      ID_IMP1,
    );
  });
});

// ── 5. 2 importados → most_complete_imported ─────────────────────────────────

describe('BuildManualDedupGroupUseCase — 2 importados → most_complete', () => {
  it('survivor = importado mais completo', async () => {
    const rows = [
      makeRow({
        id: ID_IMP1,
        email: 'g1@enlite.import',
        auth_uid: 'base1import_aaa',
        completeness_score: 1,
        document_count: 0,
        updated_at: new Date('2026-01-01'),
      }),
      makeRow({
        id: ID_IMP2,
        email: 'g2@enlite.import',
        auth_uid: 'base1import_bbb',
        completeness_score: 4,
        document_count: 2,
        updated_at: new Date('2026-01-02'),
      }),
    ];
    const pool = makePool(rows);
    mockLoadNames.mockResolvedValueOnce(new Map([
      [ID_IMP1, '(importado)'],
      [ID_IMP2, '(importado)'],
    ]));

    const useCase = new BuildManualDedupGroupUseCase(pool as unknown as Pool);
    const result = await useCase.execute([ID_IMP1, ID_IMP2]);

    expect(result.survivor_suggested_id).toBe(ID_IMP2);
    expect(result.survivor_reason).toBe('most_complete_imported');
  });
});
