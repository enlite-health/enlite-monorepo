const mockPoolQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: mockPoolQuery }) }) },
}));

import { PatientPhotoOrphanRepository } from '../PatientPhotoOrphanRepository';

describe('PatientPhotoOrphanRepository (426, task 4.8/4.3h)', () => {
  let repo: PatientPhotoOrphanRepository;
  beforeEach(() => {
    mockPoolQuery.mockReset().mockResolvedValue({ rows: [] });
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
});
