/**
 * AnaCareDirectorySnapshotRepository — pool mockado na fronteira (`@shared/database/DatabaseConnection`),
 * mesmo molde de `AnaCarePatientMonthRepository.test.ts`. Migrado (passo 2, conserto 17/09) do
 * antigo `AnaCareShiftRepository.test.ts` — `getLastDirectoryCount`/`setLastDirectoryCount` nunca
 * tiveram nada a ver com turno, guardam a última contagem do diretório Enlite.
 */
const mockPoolQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({ query: mockPoolQuery }) }),
  },
}));

import { AnaCareDirectorySnapshotRepository } from '../AnaCareDirectorySnapshotRepository';

describe('AnaCareDirectorySnapshotRepository', () => {
  beforeEach(() => {
    mockPoolQuery.mockReset();
  });

  describe('getLastDirectoryCount / setLastDirectoryCount', () => {
    it('sem linha ainda: devolve null (primeira execução)', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      const repo = new AnaCareDirectorySnapshotRepository();
      expect(await repo.getLastDirectoryCount()).toBeNull();
    });

    it('devolve a contagem persistida', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ last_total_count: 283 }] });
      const repo = new AnaCareDirectorySnapshotRepository();
      expect(await repo.getLastDirectoryCount()).toBe(283);
    });

    it('setLastDirectoryCount grava via upsert de linha única (id=1)', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      const repo = new AnaCareDirectorySnapshotRepository();
      await repo.setLastDirectoryCount(283);

      const [sql, params] = mockPoolQuery.mock.calls[0];
      expect(sql).toMatch(/ON CONFLICT \(id\) DO UPDATE/);
      expect(params).toEqual([283]);
    });
  });
});
