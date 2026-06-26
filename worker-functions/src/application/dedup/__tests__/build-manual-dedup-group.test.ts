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
 *   7. field_comparisons populado — has_conflict=true quando valores diferem
 *   8. field_comparisons — campo encriptado é decriptado (passthrough em NODE_ENV=test)
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
import type { KMSEncryptionService } from '@shared/security/KMSEncryptionService';

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
  // Campos de COMPARE_FIELDS
  profession: string | null;
  knowledge_level: string | null;
  years_experience: number | null;
  country: string | null;
  first_name_encrypted: string | null;
  last_name_encrypted: string | null;
  sex_encrypted: string | null;
  gender_encrypted: string | null;
  birth_date_encrypted: string | null;
  languages_encrypted: string | null;
  profile_photo_url_encrypted: string | null;
  whatsapp_phone_encrypted: string | null;
  linkedin_url_encrypted: string | null;
  sexual_orientation_encrypted: string | null;
  race_encrypted: string | null;
  religion_encrypted: string | null;
  weight_kg_encrypted: string | null;
  height_cm_encrypted: string | null;
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
    // COMPARE_FIELDS — null por padrão
    profession: null,
    knowledge_level: null,
    years_experience: null,
    country: null,
    first_name_encrypted: null,
    last_name_encrypted: null,
    sex_encrypted: null,
    gender_encrypted: null,
    birth_date_encrypted: null,
    languages_encrypted: null,
    profile_photo_url_encrypted: null,
    whatsapp_phone_encrypted: null,
    linkedin_url_encrypted: null,
    sexual_orientation_encrypted: null,
    race_encrypted: null,
    religion_encrypted: null,
    weight_kg_encrypted: null,
    height_cm_encrypted: null,
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

// ── 6. field_comparisons — array não vazio, has_conflict ─────────────────────

describe('BuildManualDedupGroupUseCase — field_comparisons', () => {
  it('retorna field_comparisons não-vazio quando 2 contas são fornecidas', async () => {
    const rows = [
      makeRow({ id: ID_REAL1, email: 'real@example.com', auth_uid: 'FirebaseReal_fc1', profession: 'AT' }),
      makeRow({ id: ID_IMP1,  email: 'g@enlite.import',  auth_uid: 'base1import_fc1', profession: null }),
    ];
    const pool = makePool(rows);
    mockLoadNames.mockResolvedValueOnce(new Map([
      [ID_REAL1, 'Ana'],
      [ID_IMP1,  '(importado)'],
    ]));

    const useCase = new BuildManualDedupGroupUseCase(pool as unknown as Pool);
    const result = await useCase.execute([ID_REAL1, ID_IMP1]);

    expect(Array.isArray(result.field_comparisons)).toBe(true);
    expect(result.field_comparisons.length).toBeGreaterThan(0);
  });

  it('has_conflict=true quando 2 contas têm valores distintos no mesmo campo', async () => {
    const rows = [
      makeRow({ id: ID_REAL1, email: 'r@example.com', auth_uid: 'FirebaseReal_hc1', profession: 'AT' }),
      makeRow({ id: ID_IMP1,  email: 'g@enlite.import', auth_uid: 'base1import_hc1', profession: 'CUIDADOR' }),
    ];
    const pool = makePool(rows);
    mockLoadNames.mockResolvedValueOnce(new Map([
      [ID_REAL1, 'X'],
      [ID_IMP1,  'Y'],
    ]));

    const useCase = new BuildManualDedupGroupUseCase(pool as unknown as Pool);
    const result = await useCase.execute([ID_REAL1, ID_IMP1]);

    const profCmp = result.field_comparisons.find(f => f.field === 'profession');
    expect(profCmp).toBeDefined();
    expect(profCmp!.has_conflict).toBe(true);
    expect(profCmp!.is_encrypted).toBe(false);
    expect(profCmp!.values[ID_REAL1]).toBe('AT');
    expect(profCmp!.values[ID_IMP1]).toBe('CUIDADOR');
  });

  it('campo encriptado: is_encrypted=true, decriptado e conflito sobre plaintext', async () => {
    // KMSEncryptionService em NODE_ENV=test usa passthrough (base64 decode).
    // Aqui injetamos um encryptionService spy com passthrough determinístico.
    const cipher = (s: string) => Buffer.from(s, 'utf8').toString('base64');

    const rows = [
      makeRow({
        id: ID_REAL1,
        email: 'r@example.com',
        auth_uid: 'FirebaseReal_enc1',
        first_name_encrypted: cipher('Ana'),
      }),
      makeRow({
        id: ID_IMP1,
        email: 'g@enlite.import',
        auth_uid: 'base1import_enc1',
        first_name_encrypted: cipher('Maria'),
      }),
    ];
    const pool = makePool(rows);
    mockLoadNames.mockResolvedValueOnce(new Map([
      [ID_REAL1, 'Ana'],
      [ID_IMP1,  '(importado)'],
    ]));

    // Serviço passthrough: decrypt = base64 → utf8
    const passthroughEncryption = {
      decrypt: jest.fn(async (ct: string) => Buffer.from(ct, 'base64').toString('utf8')),
    } as unknown as KMSEncryptionService;

    const useCase = new BuildManualDedupGroupUseCase(
      pool as unknown as Pool,
      passthroughEncryption,
    );
    const result = await useCase.execute([ID_REAL1, ID_IMP1]);

    const encCmp = result.field_comparisons.find(f => f.field === 'first_name_encrypted');
    expect(encCmp).toBeDefined();
    expect(encCmp!.is_encrypted).toBe(true);
    expect(encCmp!.values[ID_REAL1]).toBe('Ana');
    expect(encCmp!.values[ID_IMP1]).toBe('Maria');
    expect(encCmp!.has_conflict).toBe(true);
  });

  it('shape de FieldComparison correto (field, values, is_encrypted, has_conflict)', async () => {
    const rows = [
      makeRow({ id: ID_REAL1, email: 'r@example.com', auth_uid: 'FirebaseReal_sh1' }),
      makeRow({ id: ID_IMP1,  email: 'g@enlite.import', auth_uid: 'base1import_sh1' }),
    ];
    const pool = makePool(rows);
    mockLoadNames.mockResolvedValueOnce(new Map([
      [ID_REAL1, 'X'],
      [ID_IMP1,  'Y'],
    ]));

    const useCase = new BuildManualDedupGroupUseCase(pool as unknown as Pool);
    const result = await useCase.execute([ID_REAL1, ID_IMP1]);

    for (const cmp of result.field_comparisons) {
      expect(typeof cmp.field).toBe('string');
      expect(typeof cmp.is_encrypted).toBe('boolean');
      expect(typeof cmp.has_conflict).toBe('boolean');
      expect(typeof cmp.values).toBe('object');
      expect(cmp.values).not.toBeNull();
      // values deve ter chave para cada account
      expect(Object.keys(cmp.values)).toContain(ID_REAL1);
      expect(Object.keys(cmp.values)).toContain(ID_IMP1);
    }
  });
});
