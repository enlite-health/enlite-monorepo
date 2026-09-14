/**
 * WorkerRepository.findAbsorbedWorkerIds.test.ts
 *
 * Hotfix 14/09 — o método é um repasse fino para o helper compartilhado
 * `@shared/database/findAbsorbedWorkerIds` (a lógica de verdade, com a CTE
 * de cadeia reversa, é testada em `src/shared/database/__tests__/
 * findAbsorbedWorkerIds.test.ts`). Aqui só prova que o repositório passa o
 * `pool` certo e devolve o resultado do helper sem alterar.
 */

const mockQuery = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: () => ({ getPool: () => ({ query: mockQuery }) }),
  },
}));

jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('@shared/security/BlindIndexService', () => ({
  BlindIndexService: jest.fn().mockImplementation(() => ({})),
}));

import { WorkerRepository } from '../WorkerRepository';

describe('WorkerRepository.findAbsorbedWorkerIds', () => {
  let repo: WorkerRepository;

  beforeEach(() => {
    mockQuery.mockReset();
    repo = new WorkerRepository();
  });

  it('repassa para o helper compartilhado e devolve os ids da CTE', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 'absorbed-1' }, { id: 'absorbed-2' }] });
    const result = await repo.findAbsorbedWorkerIds('survivor-1');
    expect(result).toEqual(['absorbed-1', 'absorbed-2']);
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('WITH RECURSIVE survivor'), ['survivor-1', 10]);
  });

  it('sobrevivente sem absorvidos → []', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const result = await repo.findAbsorbedWorkerIds('survivor-sem-absorvidos');
    expect(result).toEqual([]);
  });
});
