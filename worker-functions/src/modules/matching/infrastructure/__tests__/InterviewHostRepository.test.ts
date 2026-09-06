/**
 * InterviewHostRepository.test.ts
 *
 * A ordem por e-mail não é estética: é o desempate determinístico da
 * atribuição. Se ela depender da ordem física das linhas no Postgres, duas
 * execuções idênticas podem escolher atendentes diferentes — que é justamente
 * o que o spec proíbe.
 */

const mockQuery = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({ query: mockQuery }),
    }),
  },
}));

import { InterviewHostRepository, interviewHostRepository } from '../InterviewHostRepository';

describe('InterviewHostRepository', () => {
  const repo = new InterviewHostRepository();

  beforeEach(() => jest.clearAllMocks());

  it('pede só as ativas do país, ordenadas por e-mail', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await repo.listActiveByCountry('BR');

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('FROM interview_hosts');
    expect(sql).toContain('active = true');
    expect(sql).toContain('ORDER BY email ASC');
    expect(params).toEqual(['BR']);
  });

  it('traduz a linha do banco para o domínio', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { email: 'ana@enlite.health', display_name: 'Ana Joulie' },
        { email: 'mari@enlite.health', display_name: null },
      ],
    });

    await expect(repo.listActiveByCountry('AR')).resolves.toEqual([
      { email: 'ana@enlite.health', displayName: 'Ana Joulie' },
      { email: 'mari@enlite.health', displayName: null },
    ]);
  });

  it('país sem atendente → lista vazia, não erro', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await expect(repo.listActiveByCountry('BR')).resolves.toEqual([]);
  });

  it('exporta um singleton pronto para uso', () => {
    expect(interviewHostRepository).toBeInstanceOf(InterviewHostRepository);
  });
});
