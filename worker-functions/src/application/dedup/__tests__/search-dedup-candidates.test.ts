/**
 * search-dedup-candidates.test.ts
 *
 * Testes unitários de SearchDedupCandidatesUseCase.
 * Pool é mockado (sem banco real).
 *
 * Cobre:
 *   1. q < 2 chars → retorna []
 *   2. busca por nome (gera trigrams, faz query com @>)
 *   3. busca por telefone (q contém dígitos) → emite query ILIKE
 *   4. combina nome + telefone (sem duplicatas no resultado)
 *   5. exclui worker com merged_into_id IS NOT NULL (filtro no SQL)
 *   6. shape de CandidateItem correto (login_real, is_imported)
 *   7. q sem dígitos → não faz query de telefone
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

jest.mock('@shared/security/BlindIndexService', () => ({
  BlindIndexService: jest.fn().mockImplementation(() => ({
    generateSearchTrigramBidx: jest.fn().mockResolvedValue([Buffer.from('abc')]),
    serializeForPg: jest.fn().mockReturnValue('{"\\\\x616263"}'),
  })),
}));

import type { Pool } from 'pg';
import { SearchDedupCandidatesUseCase } from '../SearchDedupCandidatesUseCase';
import { loadWorkerDisplayNames } from '../loadWorkerDisplayNames';

const ID_REAL     = 'aaaaaaaa-1111-0000-0000-000000000001';
const ID_IMPORT   = 'aaaaaaaa-2222-0000-0000-000000000002';
const ID_PHONE    = 'aaaaaaaa-3333-0000-0000-000000000003';

// ── Pool factory ──────────────────────────────────────────────────────────────

/**
 * Cria um mock de pool que responde a queries na ordem em que são feitas.
 * Cada chamada a query() consome o próximo item de `responses`.
 */
function makePool(responses: Array<{ rows: unknown[] }>): jest.Mocked<Pick<Pool, 'query'>> {
  let callIndex = 0;
  return {
    query: jest.fn().mockImplementation(() => {
      const resp = responses[callIndex] ?? { rows: [] };
      callIndex++;
      return Promise.resolve(resp);
    }),
  } as unknown as jest.Mocked<Pick<Pool, 'query'>>;
}

const mockLoadNames = loadWorkerDisplayNames as jest.MockedFunction<typeof loadWorkerDisplayNames>;

beforeEach(() => {
  jest.clearAllMocks();
});

// ── 1. q < 2 chars → [] ──────────────────────────────────────────────────────

describe('SearchDedupCandidatesUseCase — q curto', () => {
  it('retorna [] quando q tem 0 chars', async () => {
    const pool = makePool([]);
    const useCase = new SearchDedupCandidatesUseCase(pool as unknown as Pool);
    const result = await useCase.execute({ q: '' });
    expect(result).toEqual([]);
    expect((pool.query as jest.Mock).mock.calls).toHaveLength(0);
  });

  it('retorna [] quando q tem 1 char', async () => {
    const pool = makePool([]);
    const useCase = new SearchDedupCandidatesUseCase(pool as unknown as Pool);
    const result = await useCase.execute({ q: 'a' });
    expect(result).toEqual([]);
  });

  it('não retorna [] quando q tem 2 chars', async () => {
    // 2 chars sem dígitos — trigram deve ser tentado mas BlindIndex pode lançar
    // (o mock retorna buffers, então deve emitir query)
    mockLoadNames.mockResolvedValueOnce(new Map([[ID_REAL, 'Ana García']]));
    const pool = makePool([
      { rows: [{ id: ID_REAL }] },    // busca por nome
      // sem dígitos → sem busca por telefone
      { rows: [{ id: ID_REAL, email: 'real@example.com', phone_normalized: null, auth_uid: 'FirebaseReal' }] },
    ]);
    const useCase = new SearchDedupCandidatesUseCase(pool as unknown as Pool);
    const result = await useCase.execute({ q: 'An' });
    expect(result).toHaveLength(1);
  });
});

// ── 2. busca por nome ─────────────────────────────────────────────────────────

describe('SearchDedupCandidatesUseCase — busca por nome', () => {
  it('emite query com name_trgm_bidx e retorna candidato', async () => {
    mockLoadNames.mockResolvedValueOnce(new Map([[ID_REAL, 'María González']]));
    const pool = makePool([
      { rows: [{ id: ID_REAL }] },    // nome
      // sem dígitos em 'María González' → sem telefone
      { rows: [{ id: ID_REAL, email: 'real@example.com', phone_normalized: '54911111', auth_uid: 'FirebaseReal' }] },
    ]);

    const useCase = new SearchDedupCandidatesUseCase(pool as unknown as Pool);
    const result = await useCase.execute({ q: 'María' });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(ID_REAL);
    expect(result[0].name).toBe('María González');
    expect(result[0].login_real).toBe(true);
    expect(result[0].is_imported).toBe(false);
  });
});

// ── 3. busca por telefone ─────────────────────────────────────────────────────

describe('SearchDedupCandidatesUseCase — busca por telefone', () => {
  it('emite query ILIKE quando q contém dígitos', async () => {
    mockLoadNames.mockResolvedValueOnce(new Map([[ID_PHONE, 'Carlos Rojas']]));
    // q = '9111' → tem dígitos → busca nome + telefone
    const pool = makePool([
      { rows: [] },   // nome (sem resultado por nome)
      { rows: [{ id: ID_PHONE }] },  // telefone
      { rows: [{ id: ID_PHONE, email: 'carlos@example.com', phone_normalized: '549111155551', auth_uid: 'FirebaseReal2' }] },
    ]);

    const useCase = new SearchDedupCandidatesUseCase(pool as unknown as Pool);
    const result = await useCase.execute({ q: '9111' });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(ID_PHONE);
    expect(result[0].phone).toBe('549111155551');

    const queryCalls = (pool.query as jest.Mock).mock.calls;
    // 2 buscas (nome + telefone) + 1 fetchCandidateRows
    expect(queryCalls).toHaveLength(3);
    // query de telefone tem ILIKE
    const phoneQuerySql = String(queryCalls[1][0]);
    expect(phoneQuerySql).toContain('ILIKE');
  });
});

// ── 4. dedup nome+telefone (sem duplicatas) ───────────────────────────────────

describe('SearchDedupCandidatesUseCase — dedup entre nome e telefone', () => {
  it('não duplica id que aparece em ambas as buscas', async () => {
    mockLoadNames.mockResolvedValueOnce(new Map([[ID_REAL, 'Pedro García']]));
    // ID_REAL aparece em ambas as buscas (nome + telefone)
    const pool = makePool([
      { rows: [{ id: ID_REAL }] },   // nome
      { rows: [{ id: ID_REAL }] },   // telefone (mesmo id)
      { rows: [{ id: ID_REAL, email: 'pedro@example.com', phone_normalized: '5491234', auth_uid: 'FirebaseReal' }] },
    ]);

    const useCase = new SearchDedupCandidatesUseCase(pool as unknown as Pool);
    // '5491234' tem dígitos
    const result = await useCase.execute({ q: '5491234' });

    // Só deve retornar 1 item, não 2
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(ID_REAL);
  });
});

// ── 5. exclui worker mergeado (filtro no SQL) ─────────────────────────────────

describe('SearchDedupCandidatesUseCase — exclui mergeados', () => {
  it('query SQL inclui merged_into_id IS NULL', async () => {
    mockLoadNames.mockResolvedValueOnce(new Map());
    const pool = makePool([
      { rows: [] },  // nome
      // sem dígitos
      { rows: [] },  // fetchCandidateRows (ids vazio → não chama)
    ]);

    const useCase = new SearchDedupCandidatesUseCase(pool as unknown as Pool);
    await useCase.execute({ q: 'Ana' });

    const firstCall = (pool.query as jest.Mock).mock.calls[0];
    expect(String(firstCall[0])).toContain('merged_into_id IS NULL');
  });
});

// ── 6. shape de CandidateItem (is_imported + login_real) ─────────────────────

describe('SearchDedupCandidatesUseCase — shape do CandidateItem', () => {
  it('is_imported=true para email @enlite.import', async () => {
    mockLoadNames.mockResolvedValueOnce(new Map([[ID_IMPORT, '(importado)']]));
    const pool = makePool([
      { rows: [{ id: ID_IMPORT }] },
      { rows: [{ id: ID_IMPORT, email: `ghost@enlite.import`, phone_normalized: null, auth_uid: 'base1import_abc' }] },
    ]);

    const useCase = new SearchDedupCandidatesUseCase(pool as unknown as Pool);
    const result = await useCase.execute({ q: 'ghost' });

    expect(result[0].is_imported).toBe(true);
    expect(result[0].login_real).toBe(false);
  });

  it('login_real=true para conta real (uid não-sintético, email não-import)', async () => {
    mockLoadNames.mockResolvedValueOnce(new Map([[ID_REAL, 'Real User']]));
    const pool = makePool([
      { rows: [{ id: ID_REAL }] },
      { rows: [{ id: ID_REAL, email: 'real@example.com', phone_normalized: null, auth_uid: 'FirebaseRealUID' }] },
    ]);

    const useCase = new SearchDedupCandidatesUseCase(pool as unknown as Pool);
    const result = await useCase.execute({ q: 'Real' });

    expect(result[0].login_real).toBe(true);
    expect(result[0].is_imported).toBe(false);
  });
});

// ── 7. q sem dígitos → não emite query de telefone ───────────────────────────

describe('SearchDedupCandidatesUseCase — sem dígitos → sem query de telefone', () => {
  it('emite apenas query de nome quando q não tem dígitos', async () => {
    mockLoadNames.mockResolvedValueOnce(new Map());
    const pool = makePool([
      { rows: [] },  // nome
      { rows: [] },  // fetchCandidateRows
    ]);

    const useCase = new SearchDedupCandidatesUseCase(pool as unknown as Pool);
    await useCase.execute({ q: 'Ana' });

    const queryCalls = (pool.query as jest.Mock).mock.calls;
    // Apenas 1 busca (nome) — fetchCandidateRows não roda porque ids=[],
    // então total de chamadas ao pool = 1
    expect(queryCalls).toHaveLength(1);
  });
});
