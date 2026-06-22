/**
 * list-dedup-groups.test.ts
 *
 * Testes unitários de ListDedupGroupsUseCase.
 * Cobre: lista vazia, grupos com tier1/tier2/tier3, survivor sugerido,
 * grupos com apenas 1 worker ativo (skip), múltiplos tier1 (conflict).
 */

jest.mock('@shared/logging', () => ({
  logger: { child: jest.fn().mockReturnValue({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) },
  reportError: jest.fn(),
}));

import type { Pool } from 'pg';
import { ListDedupGroupsUseCase } from '../ListDedupGroupsUseCase';

const BASE_DATE = new Date('2026-01-01T00:00:00Z');

function makePool(responses: Array<{ rows: unknown[] }>): jest.Mocked<Pick<Pool, 'query'>> {
  let idx = 0;
  return {
    query: jest.fn().mockImplementation(() => {
      const resp = responses[idx++] ?? { rows: [] };
      return Promise.resolve(resp);
    }),
  } as unknown as jest.Mocked<Pick<Pool, 'query'>>;
}

const ID1 = 'dddddddd-0001-0000-0000-000000000001';
const ID2 = 'dddddddd-0002-0000-0000-000000000002';
const ID3 = 'dddddddd-0003-0000-0000-000000000003';
const PHONE_A = '5491100000001';
const PHONE_B = '5491100000002';

function rawWorkerRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ID1,
    email: 'w1@example.com',
    auth_uid: 'FirebaseReal_a1',
    status: 'REGISTERED',
    created_at: BASE_DATE,
    updated_at: BASE_DATE,
    document_number_encrypted: null,
    data_sources: null,
    completeness_score: 3,
    document_count: 1,
    wja_count: 2,
    encuadres_count: 0,
    ...overrides,
  };
}

// ── Lista vazia ────────────────────────────────────────────────────────────────

describe('ListDedupGroupsUseCase — lista vazia', () => {
  it('retorna [] quando não há colisões não resolvidas', async () => {
    const pool = makePool([{ rows: [] }]);
    const useCase = new ListDedupGroupsUseCase(pool as unknown as Pool);
    const result = await useCase.execute();
    expect(result).toEqual([]);
  });
});

// ── Grupos com tier1 (survivor único) ─────────────────────────────────────────

describe('ListDedupGroupsUseCase — survivor tier1', () => {
  it('elege tier1 como survivor_suggested_id com razão tier1_real_human', async () => {
    const pool = makePool([
      // colisões
      { rows: [{ phone_normalized: PHONE_A, worker_ids: [ID1, ID2] }] },
      // workers para o grupo
      { rows: [
        rawWorkerRow({ id: ID1, auth_uid: 'FirebaseReal_xxx', email: 'real@example.com' }),
        rawWorkerRow({ id: ID2, auth_uid: 'base1import_yyy', email: 'import@enlite.import', completeness_score: 1 }),
      ]},
    ]);

    const useCase = new ListDedupGroupsUseCase(pool as unknown as Pool);
    const result = await useCase.execute();

    expect(result).toHaveLength(1);
    expect(result[0].survivor_suggested_id).toBe(ID1);
    expect(result[0].survivor_reason).toBe('tier1_real_human');
    expect(result[0].phone_normalized).toBe(PHONE_A);
  });

  it('accounts têm tier, login_real, auth_uid_prefix corretamente', async () => {
    const pool = makePool([
      { rows: [{ phone_normalized: PHONE_A, worker_ids: [ID1, ID2] }] },
      { rows: [
        rawWorkerRow({ id: ID1, auth_uid: 'FirebaseReal_abc', email: 'r@example.com' }),
        rawWorkerRow({ id: ID2, auth_uid: 'base1import_xyz', email: 'ghost@enlite.import' }),
      ]},
    ]);

    const useCase = new ListDedupGroupsUseCase(pool as unknown as Pool);
    const result = await useCase.execute();

    const tier1Account = result[0].accounts.find(a => a.id === ID1);
    const tier3Account = result[0].accounts.find(a => a.id === ID2);

    expect(tier1Account?.tier).toBe(1);
    expect(tier1Account?.login_real).toBe(true);
    expect(tier1Account?.auth_uid_prefix).toBe('real');
    expect(tier3Account?.tier).toBe(3);
    expect(tier3Account?.login_real).toBe(false);
    expect(tier3Account?.auth_uid_prefix).toBe('base1import_');
  });
});

// ── Conflito com múltiplos tier1 ──────────────────────────────────────────────

describe('ListDedupGroupsUseCase — múltiplos tier1 = conflict', () => {
  it('survivor_suggested_id=null e razão conflict_multiple_tier1', async () => {
    const pool = makePool([
      { rows: [{ phone_normalized: PHONE_A, worker_ids: [ID1, ID2] }] },
      { rows: [
        rawWorkerRow({ id: ID1, auth_uid: 'FirebaseReal_aaa', email: 'r1@example.com' }),
        rawWorkerRow({ id: ID2, auth_uid: 'FirebaseReal_bbb', email: 'r2@example.com' }),
      ]},
    ]);

    const useCase = new ListDedupGroupsUseCase(pool as unknown as Pool);
    const result = await useCase.execute();

    expect(result[0].survivor_suggested_id).toBeNull();
    expect(result[0].survivor_reason).toBe('conflict_multiple_tier1');
  });
});

// ── Tier2 como survivor ────────────────────────────────────────────────────────

describe('ListDedupGroupsUseCase — survivor tier2', () => {
  it('elege tier2 mais completo como survivor com razão most_complete_tier2', async () => {
    const pool = makePool([
      { rows: [{ phone_normalized: PHONE_A, worker_ids: [ID1, ID2] }] },
      { rows: [
        rawWorkerRow({ id: ID1, auth_uid: 'FirebaseReal_t2a', email: 'tier2a@enlite.import', completeness_score: 2, document_count: 1, updated_at: new Date('2026-01-02') }),
        rawWorkerRow({ id: ID2, auth_uid: 'FirebaseReal_t2b', email: 'tier2b@enlite.import', completeness_score: 5, document_count: 3, updated_at: new Date('2026-01-03') }),
      ]},
    ]);

    const useCase = new ListDedupGroupsUseCase(pool as unknown as Pool);
    const result = await useCase.execute();

    expect(result[0].survivor_reason).toBe('most_complete_tier2');
    // ID2 é mais completo
    expect(result[0].survivor_suggested_id).toBe(ID2);
  });
});

// ── Tier3 como survivor ────────────────────────────────────────────────────────

describe('ListDedupGroupsUseCase — survivor tier3 (todos sintéticos)', () => {
  it('elege mais completo entre tier3 com razão most_complete_tier3', async () => {
    const pool = makePool([
      { rows: [{ phone_normalized: PHONE_A, worker_ids: [ID1, ID2] }] },
      { rows: [
        rawWorkerRow({ id: ID1, auth_uid: 'base1import_aaa', email: 'g1@enlite.import', completeness_score: 1, document_count: 0 }),
        rawWorkerRow({ id: ID2, auth_uid: 'base1import_bbb', email: 'g2@enlite.import', completeness_score: 4, document_count: 2 }),
      ]},
    ]);

    const useCase = new ListDedupGroupsUseCase(pool as unknown as Pool);
    const result = await useCase.execute();

    expect(result[0].survivor_reason).toBe('most_complete_tier3');
    expect(result[0].survivor_suggested_id).toBe(ID2);
  });
});

// ── Grupo com apenas 1 worker ativo → skip ────────────────────────────────────

describe('ListDedupGroupsUseCase — skip grupo com 1 ativo', () => {
  it('não inclui grupo quando fetchWorkers retorna apenas 1 worker ativo', async () => {
    const pool = makePool([
      { rows: [{ phone_normalized: PHONE_A, worker_ids: [ID1, ID2] }] },
      // apenas 1 worker ativo
      { rows: [rawWorkerRow({ id: ID1, auth_uid: 'FirebaseReal_only' })] },
    ]);

    const useCase = new ListDedupGroupsUseCase(pool as unknown as Pool);
    const result = await useCase.execute();

    expect(result).toHaveLength(0);
  });
});

// ── isSyntheticUid e extractPrefix com null/undefined (branch 175-180) ───────

describe('ListDedupGroupsUseCase — auth_uid null (branches 175-180)', () => {
  it('auth_uid null → isSyntheticUid retorna true; extractPrefix retorna "null"', async () => {
    const pool = makePool([
      { rows: [{ phone_normalized: PHONE_A, worker_ids: [ID1, ID2] }] },
      { rows: [
        rawWorkerRow({ id: ID1, auth_uid: null, email: 'r1@example.com', completeness_score: 4 }),
        rawWorkerRow({ id: ID2, auth_uid: null, email: 'r2@example.com', completeness_score: 2 }),
      ]},
    ]);

    const useCase = new ListDedupGroupsUseCase(pool as unknown as Pool);
    const result = await useCase.execute();

    expect(result).toHaveLength(1);
    // ambos com auth_uid null → tier 3 (sintético)
    expect(result[0].accounts.every(a => a.tier === 3)).toBe(true);
    expect(result[0].accounts.every(a => a.auth_uid_prefix === 'null')).toBe(true);
    expect(result[0].accounts.every(a => a.login_real === false)).toBe(true);
    expect(result[0].survivor_reason).toBe('most_complete_tier3');
  });

  it('auth_uid undefined → isSyntheticUid retorna true (branch !authUid, linha 175)', async () => {
    const pool = makePool([
      { rows: [{ phone_normalized: PHONE_A, worker_ids: [ID1, ID2] }] },
      { rows: [
        rawWorkerRow({ id: ID1, auth_uid: undefined, email: 'u1@example.com' }),
        rawWorkerRow({ id: ID2, auth_uid: undefined, email: 'u2@example.com' }),
      ]},
    ]);

    const useCase = new ListDedupGroupsUseCase(pool as unknown as Pool);
    const result = await useCase.execute();

    expect(result[0].accounts.every(a => a.tier === 3)).toBe(true);
  });
});

// ── Múltiplos grupos ──────────────────────────────────────────────────────────

describe('ListDedupGroupsUseCase — múltiplos grupos', () => {
  it('processa múltiplos grupos independentemente', async () => {
    const pool = makePool([
      // 2 colisões
      { rows: [
        { phone_normalized: PHONE_A, worker_ids: [ID1, ID2] },
        { phone_normalized: PHONE_B, worker_ids: [ID3, ID2] },
      ]},
      // workers grupo A
      { rows: [
        rawWorkerRow({ id: ID1, auth_uid: 'FirebaseReal_grpA', email: 'a@example.com' }),
        rawWorkerRow({ id: ID2, auth_uid: 'base1import_grpA', email: 'b@enlite.import' }),
      ]},
      // workers grupo B
      { rows: [
        rawWorkerRow({ id: ID3, auth_uid: 'FirebaseReal_grpB', email: 'c@example.com' }),
        rawWorkerRow({ id: ID2, auth_uid: 'base1import_grpB', email: 'd@enlite.import' }),
      ]},
    ]);

    const useCase = new ListDedupGroupsUseCase(pool as unknown as Pool);
    const result = await useCase.execute();

    expect(result).toHaveLength(2);
    expect(result.map(g => g.phone_normalized)).toContain(PHONE_A);
    expect(result.map(g => g.phone_normalized)).toContain(PHONE_B);
  });
});
