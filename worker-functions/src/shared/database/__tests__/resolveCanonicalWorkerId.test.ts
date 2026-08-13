/**
 * resolveCanonicalWorkerId.test.ts
 *
 * Unit (pool mockado) do helper único de resolução de corrente de merge:
 *   - id vivo → devolve o próprio
 *   - mergeado → devolve o fim da corrente (1 e 2 saltos)
 *   - id inexistente → null
 *   - corrente circular → null sem travar (a CTE é limitada por MAX_MERGE_DEPTH)
 */

jest.mock('@shared/logging', () => ({
  logger:      { child: jest.fn().mockReturnValue({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }) },
  reportError: jest.fn(),
  loggingAls:  { run: jest.fn(), getStore: jest.fn().mockReturnValue(undefined) },
}));

import type { Pool } from 'pg';
import { resolveCanonicalWorkerId, MAX_MERGE_DEPTH } from '../resolveCanonicalWorkerId';

function makePool(rows: unknown[]): Pool {
  return { query: jest.fn().mockResolvedValue({ rows }) } as unknown as Pool;
}

describe('resolveCanonicalWorkerId', () => {
  it('id vivo → devolve o próprio id', async () => {
    const pool = makePool([{ id: 'w-live', depth: 0, merged_into_id: null }]);
    await expect(resolveCanonicalWorkerId(pool, 'w-live')).resolves.toBe('w-live');
  });

  it('mergeado 1 salto → devolve o survivor', async () => {
    // A CTE devolve a linha MAIS PROFUNDA (ORDER BY depth DESC LIMIT 1)
    const pool = makePool([{ id: 'w-survivor', depth: 1, merged_into_id: null }]);
    await expect(resolveCanonicalWorkerId(pool, 'w-absorbed')).resolves.toBe('w-survivor');
  });

  it('corrente de 2 saltos → devolve o fim da corrente', async () => {
    const pool = makePool([{ id: 'w-final', depth: 2, merged_into_id: null }]);
    await expect(resolveCanonicalWorkerId(pool, 'w-oldest')).resolves.toBe('w-final');
  });

  it('id inexistente → null', async () => {
    const pool = makePool([]);
    await expect(resolveCanonicalWorkerId(pool, 'w-ghost')).resolves.toBeNull();
  });

  it('corrente circular → null sem travar (linha mais profunda ainda mergeada)', async () => {
    const pool = makePool([{ id: 'w-b', depth: MAX_MERGE_DEPTH, merged_into_id: 'w-a' }]);
    await expect(resolveCanonicalWorkerId(pool, 'w-a')).resolves.toBeNull();
  });

  it('passa o limite de profundidade como parâmetro da CTE', async () => {
    const pool = makePool([{ id: 'x', depth: 0, merged_into_id: null }]);
    await resolveCanonicalWorkerId(pool, 'x');
    const [, params] = (pool.query as jest.Mock).mock.calls[0];
    expect(params).toEqual(['x', MAX_MERGE_DEPTH]);
  });
});
