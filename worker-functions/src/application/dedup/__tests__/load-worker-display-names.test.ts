import { loadWorkerDisplayNames, IMPORTED_NAME_FALLBACK, NO_NAME_FALLBACK } from '../loadWorkerDisplayNames';
import type { Pool } from 'pg';
import type { KMSEncryptionService } from '@shared/security/KMSEncryptionService';

// decrypt passthrough: o "ciphertext" do mock JÁ é o plaintext; 'boom' lança.
const fakeEnc = {
  decrypt: jest.fn(async (ct: string | null | undefined) => {
    if (ct === 'boom') throw new Error('KMS decrypt boom');
    return String(ct ?? '');
  }),
} as unknown as KMSEncryptionService;

function poolReturning(rows: unknown[]): Pool {
  return { query: jest.fn(async () => ({ rows })) } as unknown as Pool;
}

describe('loadWorkerDisplayNames', () => {
  beforeEach(() => jest.clearAllMocks());

  it('monta nome completo decriptado (first + last)', async () => {
    const pool = poolReturning([
      { id: 'a', first_name_encrypted: 'María', last_name_encrypted: 'González', email: 'm@x.com' },
    ]);
    const names = await loadWorkerDisplayNames(pool, ['a'], fakeEnc);
    expect(names.get('a')).toBe('María González');
  });

  it('sem nome + email @enlite.import → fallback "(importado)"', async () => {
    const pool = poolReturning([
      { id: 'b', first_name_encrypted: null, last_name_encrypted: null, email: 'x@enlite.import' },
    ]);
    const names = await loadWorkerDisplayNames(pool, ['b'], fakeEnc);
    expect(names.get('b')).toBe(IMPORTED_NAME_FALLBACK);
  });

  it('sem nome + conta real → fallback "(sin nombre)"', async () => {
    const pool = poolReturning([
      { id: 'c', first_name_encrypted: null, last_name_encrypted: null, email: 'real@gmail.com' },
    ]);
    const names = await loadWorkerDisplayNames(pool, ['c'], fakeEnc);
    expect(names.get('c')).toBe(NO_NAME_FALLBACK);
  });

  it('decrypt que lança é gracioso → cai no fallback, não derruba', async () => {
    const pool = poolReturning([
      { id: 'd', first_name_encrypted: 'boom', last_name_encrypted: 'boom', email: 'real@gmail.com' },
    ]);
    const names = await loadWorkerDisplayNames(pool, ['d'], fakeEnc);
    expect(names.get('d')).toBe(NO_NAME_FALLBACK);
  });

  it('só first_name presente → usa só ele', async () => {
    const pool = poolReturning([
      { id: 'e', first_name_encrypted: 'Juan', last_name_encrypted: null, email: 'j@x.com' },
    ]);
    const names = await loadWorkerDisplayNames(pool, ['e'], fakeEnc);
    expect(names.get('e')).toBe('Juan');
  });

  it('lista de ids vazia não consulta o banco', async () => {
    const pool = poolReturning([]);
    const names = await loadWorkerDisplayNames(pool, [], fakeEnc);
    expect(names.size).toBe(0);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('deduplica ids antes de consultar', async () => {
    const pool = poolReturning([
      { id: 'a', first_name_encrypted: 'Ana', last_name_encrypted: 'Lopez', email: 'a@x.com' },
    ]);
    await loadWorkerDisplayNames(pool, ['a', 'a', 'a'], fakeEnc);
    const call = (pool.query as jest.Mock).mock.calls[0];
    expect(call[1][0]).toEqual(['a']); // $1 = array sem duplicatas
  });
});
