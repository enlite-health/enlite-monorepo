const mockPoolQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();
const mockPoolConnect = jest.fn(async () => ({ query: mockClientQuery, release: mockClientRelease }));
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: mockPoolQuery, connect: mockPoolConnect }) }) },
}));

import { PatientPhotoOrphanRepository } from '../PatientPhotoOrphanRepository';

describe('PatientPhotoOrphanRepository (426, task 4.8/4.3h)', () => {
  let repo: PatientPhotoOrphanRepository;
  beforeEach(() => {
    mockPoolQuery.mockReset().mockResolvedValue({ rows: [] });
    mockClientQuery.mockReset().mockResolvedValue({ rows: [] });
    mockClientRelease.mockReset();
    mockPoolConnect.mockClear();
    repo = new PatientPhotoOrphanRepository();
  });

  it('record — grava caminho/bucket/motivo', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 'o1' }] });
    const result = await repo.record('enc(x)', 'PHOTOS', 'REPLACE');
    expect(result).toEqual({ id: 'o1' });
    expect(mockPoolQuery.mock.calls[0][1]).toEqual(['enc(x)', 'PHOTOS', 'REPLACE']);
  });

  it('listPending — ordenado por created_at, respeita limit', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 'o1' }] });
    await repo.listPending(10);
    expect(mockPoolQuery.mock.calls[0][0]).toContain('ORDER BY created_at ASC LIMIT $1');
    expect(mockPoolQuery.mock.calls[0][1]).toEqual([10]);
  });

  it('listPending — sem limit explícito, default é 50', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await repo.listPending();
    expect(mockPoolQuery.mock.calls[0][1]).toEqual([50]);
  });

  it('remove — apaga por id', async () => {
    await repo.remove('o1');
    expect(mockPoolQuery.mock.calls[0][1]).toEqual(['o1']);
  });

  it('countOlderThan — conta linhas mais velhas que a data', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ n: '3' }] });
    const since = new Date('2026-09-13T00:00:00Z');
    await expect(repo.countOlderThan(since)).resolves.toBe(3);
    expect(mockPoolQuery.mock.calls[0][1]).toEqual([since]);
  });

  it('countOlderThan — sem linhas, sem n → 0', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await expect(repo.countOlderThan(new Date())).resolves.toBe(0);
  });

  describe('withPendingLocked (conserto #4 da 2ª revisão — FOR UPDATE SKIP LOCKED)', () => {
    it('abre transação, seleciona com FOR UPDATE SKIP LOCKED, chama fn, comita e libera o client', async () => {
      mockClientQuery
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'o1' }] }) // SELECT ... FOR UPDATE SKIP LOCKED
        .mockResolvedValueOnce(undefined); // COMMIT
      const fn = jest.fn(async () => 'resultado');

      const result = await repo.withPendingLocked(10, fn);

      expect(result).toBe('resultado');
      expect(mockPoolConnect).toHaveBeenCalledTimes(1);
      expect(mockClientQuery.mock.calls[0][0]).toBe('BEGIN');
      expect(mockClientQuery.mock.calls[1][0]).toContain('FOR UPDATE SKIP LOCKED');
      expect(mockClientQuery.mock.calls[1][1]).toEqual([10]);
      expect(fn).toHaveBeenCalledWith([{ id: 'o1' }], expect.objectContaining({ query: mockClientQuery }));
      expect(mockClientQuery.mock.calls[2][0]).toBe('COMMIT');
      expect(mockClientRelease).toHaveBeenCalledTimes(1);
    });

    it('fn lança — faz ROLLBACK, relança o erro e ainda assim libera o client', async () => {
      mockClientQuery
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // SELECT
        .mockResolvedValueOnce(undefined); // ROLLBACK
      const fn = jest.fn(async () => { throw new Error('fn falhou'); });

      await expect(repo.withPendingLocked(5, fn)).rejects.toThrow('fn falhou');

      expect(mockClientQuery.mock.calls[2][0]).toBe('ROLLBACK');
      expect(mockClientRelease).toHaveBeenCalledTimes(1);
    });

    it('ROLLBACK também falha — não mascara o erro original, ainda libera o client', async () => {
      mockClientQuery
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // SELECT
        .mockRejectedValueOnce(new Error('rollback down')); // ROLLBACK falha
      const fn = jest.fn(async () => { throw new Error('fn falhou'); });

      await expect(repo.withPendingLocked(5, fn)).rejects.toThrow('fn falhou');
      expect(mockClientRelease).toHaveBeenCalledTimes(1);
    });
  });
});
