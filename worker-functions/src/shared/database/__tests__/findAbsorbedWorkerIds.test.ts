/**
 * findAbsorbedWorkerIds.test.ts
 *
 * Unit (pool mockado) do helper que resolve a cadeia REVERSA de merge — dado
 * o id do sobrevivente, devolve os ids de todos os workers absorvidos
 * (direto ou em cadeia), mesmo `country`, profundidade até MAX_MERGE_DEPTH.
 * Ver doc do próprio arquivo para o porquê da direção oposta a
 * `resolveCanonicalWorkerId` e por que não compartilha CTE com
 * `ReconcileMergedWorkerApplications.findMergedOrphans`.
 */

jest.mock('@shared/logging', () => ({
  logger: { child: jest.fn().mockReturnValue({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }) },
  reportError: jest.fn(),
  loggingAls: { run: jest.fn(), getStore: jest.fn().mockReturnValue(undefined) },
}));

import type { Pool } from 'pg';
import { findAbsorbedWorkerIds } from '../findAbsorbedWorkerIds';
import { MAX_MERGE_DEPTH } from '../resolveCanonicalWorkerId';

function makePool(rows: Array<{ id: string }>): Pool {
  return { query: jest.fn().mockResolvedValue({ rows }) } as unknown as Pool;
}

describe('findAbsorbedWorkerIds', () => {
  it('sobrevivente sem absorvidos → []', async () => {
    const pool = makePool([]);
    await expect(findAbsorbedWorkerIds(pool, 'survivor-1')).resolves.toEqual([]);
  });

  it('sobrevivente com 1 absorvido direto → devolve o id', async () => {
    const pool = makePool([{ id: 'absorbed-1' }]);
    await expect(findAbsorbedWorkerIds(pool, 'survivor-1')).resolves.toEqual(['absorbed-1']);
  });

  it('cadeia de 2 saltos (A→C→B) → devolve os dois ids intermediários', async () => {
    const pool = makePool([{ id: 'c' }, { id: 'a' }]);
    await expect(findAbsorbedWorkerIds(pool, 'b')).resolves.toEqual(['c', 'a']);
  });

  it('sobrevivente inexistente → [] (a CTE `survivor` fica vazia, nada casa)', async () => {
    const pool = makePool([]);
    await expect(findAbsorbedWorkerIds(pool, 'id-que-nao-existe')).resolves.toEqual([]);
  });

  it('passa o survivorId e MAX_MERGE_DEPTH como parâmetros da CTE', async () => {
    const pool = makePool([]);
    await findAbsorbedWorkerIds(pool, 'survivor-x');
    const [, params] = (pool.query as jest.Mock).mock.calls[0];
    expect(params).toEqual(['survivor-x', MAX_MERGE_DEPTH]);
  });

  it('SQL filtra por country do sobrevivente (fail-closed contra cadeia cross-country)', async () => {
    const pool = makePool([]);
    await findAbsorbedWorkerIds(pool, 'survivor-x');
    const [sql] = (pool.query as jest.Mock).mock.calls[0];
    expect(sql).toContain('w.country = s.country');
  });
});
