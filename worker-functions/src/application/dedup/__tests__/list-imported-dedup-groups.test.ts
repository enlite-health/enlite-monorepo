/**
 * list-imported-dedup-groups.test.ts
 *
 * Testes unitários de ListImportedDedupGroupsUseCase.
 *
 * Cobre toda a lógica nova:
 *   1. Grupo com exatamente 1 conta real → survivor=real, is_imported correto
 *   2. Grupo com >1 conta real           → conflict (survivor_suggested_id=null)
 *   3. Grupo com 0 conta real            → most_complete entre importados
 *   4. Ordenação: has_real=true primeiro
 *   5. Filtro onlyWithReal=true descarta grupos sem real
 *   6. Lista vazia quando DB retorna 0 linhas
 *   7. Campos de account mapeados corretamente (tier, login_real, auth_uid_prefix, is_imported)
 */

jest.mock('@shared/logging', () => ({
  logger: { child: jest.fn().mockReturnValue({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) },
  reportError: jest.fn(),
}));

import type { Pool } from 'pg';
import { ListImportedDedupGroupsUseCase } from '../ListImportedDedupGroupsUseCase';

// ── Helpers ──────────────────────────────────────────────────────────────────

const BASE_DATE = new Date('2026-01-01T00:00:00Z');

const ID_REAL     = 'aaaaaaaa-1111-0000-0000-000000000001';
const ID_IMPORT1  = 'aaaaaaaa-2222-0000-0000-000000000002';
const ID_IMPORT2  = 'aaaaaaaa-3333-0000-0000-000000000003';
const ID_REAL2    = 'aaaaaaaa-4444-0000-0000-000000000004';

const KEY_A = 'bidxhex_group_a';
const KEY_B = 'bidxhex_group_b';

function rawRow(overrides: Partial<{
  id: string;
  email: string;
  auth_uid: string | null;
  status: string;
  completeness_score: number;
  document_count: number;
  wja_count: number;
  encuadres_count: number;
  document_number_encrypted: string | null;
  data_sources: string[] | null;
  created_at: Date;
  updated_at: Date;
  name_trgm_bidx_key: string;
}> = {}): Record<string, unknown> {
  return {
    id: ID_REAL,
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
    name_trgm_bidx_key: KEY_A,
    ...overrides,
  };
}

function makePool(rows: unknown[]): jest.Mocked<Pick<Pool, 'query'>> {
  return {
    query: jest.fn().mockResolvedValue({ rows }),
  } as unknown as jest.Mocked<Pick<Pool, 'query'>>;
}

// ── 1. Lista vazia ────────────────────────────────────────────────────────────

describe('ListImportedDedupGroupsUseCase — lista vazia', () => {
  it('retorna [] quando DB não tem linhas', async () => {
    const pool = makePool([]);
    const useCase = new ListImportedDedupGroupsUseCase(pool as unknown as Pool);
    const result = await useCase.execute();
    expect(result).toEqual([]);
  });
});

// ── 2. Grupo com 1 conta real → survivor = real ───────────────────────────────

describe('ListImportedDedupGroupsUseCase — 1 conta real → survivor real', () => {
  const rows = [
    rawRow({ id: ID_REAL,    email: 'real@example.com',    auth_uid: 'FirebaseReal_abc',  name_trgm_bidx_key: KEY_A }),
    rawRow({ id: ID_IMPORT1, email: 'ghost@enlite.import', auth_uid: 'base1import_xyz',   name_trgm_bidx_key: KEY_A }),
  ];

  it('survivor_suggested_id = ID da conta real', async () => {
    const pool = makePool(rows);
    const useCase = new ListImportedDedupGroupsUseCase(pool as unknown as Pool);
    const result = await useCase.execute();

    expect(result).toHaveLength(1);
    expect(result[0].survivor_suggested_id).toBe(ID_REAL);
    expect(result[0].survivor_reason).toBe('real_account_absorbs_imported');
  });

  it('has_real = true', async () => {
    const pool = makePool(rows);
    const useCase = new ListImportedDedupGroupsUseCase(pool as unknown as Pool);
    const result = await useCase.execute();
    expect(result[0].has_real).toBe(true);
  });

  it('match_type = "name" e confidence = "name_fuzzy"', async () => {
    const pool = makePool(rows);
    const useCase = new ListImportedDedupGroupsUseCase(pool as unknown as Pool);
    const result = await useCase.execute();
    expect(result[0].match_type).toBe('name');
    expect(result[0].confidence).toBe('name_fuzzy');
  });

  it('accounts têm is_imported correto (false pra real, true pra import)', async () => {
    const pool = makePool(rows);
    const useCase = new ListImportedDedupGroupsUseCase(pool as unknown as Pool);
    const result = await useCase.execute();

    const realAcc    = result[0].accounts.find(a => a.id === ID_REAL);
    const importAcc  = result[0].accounts.find(a => a.id === ID_IMPORT1);

    expect(realAcc?.is_imported).toBe(false);
    expect(importAcc?.is_imported).toBe(true);
  });

  it('tier correto: real → tier 1, importado com auth_uid sintético → tier 3', async () => {
    const pool = makePool(rows);
    const useCase = new ListImportedDedupGroupsUseCase(pool as unknown as Pool);
    const result = await useCase.execute();

    const realAcc   = result[0].accounts.find(a => a.id === ID_REAL);
    const importAcc = result[0].accounts.find(a => a.id === ID_IMPORT1);

    expect(realAcc?.tier).toBe(1);
    expect(realAcc?.login_real).toBe(true);
    expect(importAcc?.tier).toBe(3);
    expect(importAcc?.login_real).toBe(false);
  });

  it('auth_uid_prefix: real → "real", importado → prefixo sintético', async () => {
    const pool = makePool(rows);
    const useCase = new ListImportedDedupGroupsUseCase(pool as unknown as Pool);
    const result = await useCase.execute();

    const realAcc   = result[0].accounts.find(a => a.id === ID_REAL);
    const importAcc = result[0].accounts.find(a => a.id === ID_IMPORT1);

    expect(realAcc?.auth_uid_prefix).toBe('real');
    expect(importAcc?.auth_uid_prefix).toBe('base1import_');
  });
});

// ── 3. Grupo com >1 conta real → conflict ─────────────────────────────────────

describe('ListImportedDedupGroupsUseCase — >1 conta real → conflict', () => {
  const rows = [
    rawRow({ id: ID_REAL,    email: 'real1@example.com',   auth_uid: 'FirebaseReal_aaa', name_trgm_bidx_key: KEY_A }),
    rawRow({ id: ID_REAL2,   email: 'real2@example.com',   auth_uid: 'FirebaseReal_bbb', name_trgm_bidx_key: KEY_A }),
    rawRow({ id: ID_IMPORT1, email: 'ghost@enlite.import', auth_uid: 'base1import_ccc', name_trgm_bidx_key: KEY_A }),
  ];

  it('survivor_suggested_id = null', async () => {
    const pool = makePool(rows);
    const useCase = new ListImportedDedupGroupsUseCase(pool as unknown as Pool);
    const result = await useCase.execute();

    expect(result[0].survivor_suggested_id).toBeNull();
    expect(result[0].survivor_reason).toBe('conflict_multiple_real_accounts');
  });

  it('has_real = true mesmo em conflict', async () => {
    const pool = makePool(rows);
    const useCase = new ListImportedDedupGroupsUseCase(pool as unknown as Pool);
    const result = await useCase.execute();
    expect(result[0].has_real).toBe(true);
  });
});

// ── 4. Grupo sem conta real → most_complete entre importados ──────────────────

describe('ListImportedDedupGroupsUseCase — 0 conta real → most_complete importado', () => {
  const rows = [
    rawRow({
      id: ID_IMPORT1,
      email: 'ghost1@enlite.import',
      auth_uid: 'base1import_aaa',
      completeness_score: 1,
      document_count: 0,
      updated_at: new Date('2026-01-01'),
      name_trgm_bidx_key: KEY_A,
    }),
    rawRow({
      id: ID_IMPORT2,
      email: 'ghost2@enlite.import',
      auth_uid: 'base1import_bbb',
      completeness_score: 4,
      document_count: 2,
      updated_at: new Date('2026-01-02'),
      name_trgm_bidx_key: KEY_A,
    }),
  ];

  it('survivor_suggested_id = importado mais completo (ID_IMPORT2)', async () => {
    const pool = makePool(rows);
    const useCase = new ListImportedDedupGroupsUseCase(pool as unknown as Pool);
    const result = await useCase.execute();

    expect(result[0].survivor_suggested_id).toBe(ID_IMPORT2);
    expect(result[0].survivor_reason).toBe('most_complete_imported');
  });

  it('has_real = false', async () => {
    const pool = makePool(rows);
    const useCase = new ListImportedDedupGroupsUseCase(pool as unknown as Pool);
    const result = await useCase.execute();
    expect(result[0].has_real).toBe(false);
  });

  it('todos os accounts têm is_imported = true', async () => {
    const pool = makePool(rows);
    const useCase = new ListImportedDedupGroupsUseCase(pool as unknown as Pool);
    const result = await useCase.execute();
    expect(result[0].accounts.every(a => a.is_imported)).toBe(true);
  });
});

// ── 5. Ordenação: has_real=true primeiro ──────────────────────────────────────

describe('ListImportedDedupGroupsUseCase — ordenação has_real primeiro', () => {
  const rows = [
    // Grupo B: importado-vs-importado (aparece primeiro no SELECT)
    rawRow({ id: ID_IMPORT1, email: 'g1@enlite.import', auth_uid: 'base1import_aa', name_trgm_bidx_key: KEY_B }),
    rawRow({ id: ID_IMPORT2, email: 'g2@enlite.import', auth_uid: 'base1import_bb', name_trgm_bidx_key: KEY_B }),
    // Grupo A: tem conta real
    rawRow({ id: ID_REAL,    email: 'real@example.com', auth_uid: 'FirebaseReal_cc', name_trgm_bidx_key: KEY_A }),
    rawRow({ id: 'aaaaaaaa-5555-0000-0000-000000000005', email: 'g3@enlite.import', auth_uid: 'base1import_cc', name_trgm_bidx_key: KEY_A }),
  ];

  it('grupo com has_real=true vem primeiro na lista', async () => {
    const pool = makePool(rows);
    const useCase = new ListImportedDedupGroupsUseCase(pool as unknown as Pool);
    const result = await useCase.execute();

    expect(result).toHaveLength(2);
    expect(result[0].has_real).toBe(true);
    expect(result[1].has_real).toBe(false);
  });
});

// ── 6. Filtro onlyWithReal=true ───────────────────────────────────────────────

describe('ListImportedDedupGroupsUseCase — filtro onlyWithReal', () => {
  const rows = [
    // Grupo com real
    rawRow({ id: ID_REAL,    email: 'real@example.com',   auth_uid: 'FirebaseReal_rr', name_trgm_bidx_key: KEY_A }),
    rawRow({ id: ID_IMPORT1, email: 'g1@enlite.import',   auth_uid: 'base1import_aa', name_trgm_bidx_key: KEY_A }),
    // Grupo sem real
    rawRow({ id: ID_IMPORT2, email: 'g2@enlite.import',   auth_uid: 'base1import_bb', name_trgm_bidx_key: KEY_B }),
    rawRow({ id: ID_REAL2,   email: 'g3@enlite.import',   auth_uid: 'base1import_cc', name_trgm_bidx_key: KEY_B }),
  ];

  it('onlyWithReal=true retorna apenas grupos com has_real=true', async () => {
    const pool = makePool(rows);
    const useCase = new ListImportedDedupGroupsUseCase(pool as unknown as Pool);
    const result = await useCase.execute({ onlyWithReal: true });

    expect(result.every(g => g.has_real)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    // Grupo KEY_B (sem real em g2,g3 porque ambos são @enlite.import) é excluído
    const keys = result.map(g => g.name_trgm_bidx_key);
    expect(keys).toContain(KEY_A);
    expect(keys).not.toContain(KEY_B);
  });

  it('onlyWithReal=false (default) retorna todos os grupos', async () => {
    const pool = makePool(rows);
    const useCase = new ListImportedDedupGroupsUseCase(pool as unknown as Pool);
    const result = await useCase.execute({ onlyWithReal: false });

    const keys = result.map(g => g.name_trgm_bidx_key);
    expect(keys).toContain(KEY_A);
    expect(keys).toContain(KEY_B);
  });
});

// ── 7. auth_uid = null → tier 3 / auth_uid_prefix = "null" ──────────────────

describe('ListImportedDedupGroupsUseCase — auth_uid null', () => {
  const rows = [
    rawRow({ id: ID_IMPORT1, email: 'g1@enlite.import', auth_uid: null, name_trgm_bidx_key: KEY_A }),
    rawRow({ id: ID_IMPORT2, email: 'g2@enlite.import', auth_uid: null, name_trgm_bidx_key: KEY_A }),
  ];

  it('auth_uid null → tier 3, login_real false, auth_uid_prefix "null"', async () => {
    const pool = makePool(rows);
    const useCase = new ListImportedDedupGroupsUseCase(pool as unknown as Pool);
    const result = await useCase.execute();

    expect(result[0].accounts.every(a => a.tier === 3)).toBe(true);
    expect(result[0].accounts.every(a => a.login_real === false)).toBe(true);
    expect(result[0].accounts.every(a => a.auth_uid_prefix === 'null')).toBe(true);
  });
});
