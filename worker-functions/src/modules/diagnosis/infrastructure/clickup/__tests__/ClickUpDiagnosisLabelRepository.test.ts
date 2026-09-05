/**
 * ClickUpDiagnosisLabelRepository — molde: PostgresPatientDiagnosisRepository.test.ts
 * (pool mockado; a prova do SQL real é o e2e).
 */
const mockPoolQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({ query: mockPoolQuery }) }),
  },
}));

import { ClickUpDiagnosisLabelRepository } from '../ClickUpDiagnosisLabelRepository';

describe('ClickUpDiagnosisLabelRepository', () => {
  beforeEach(() => mockPoolQuery.mockReset());

  it('resolve() devolve a concept_uri quando o rótulo tem mapeamento ATIVO', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ concept_uri: 'uri://x' }] });
    const repo = new ClickUpDiagnosisLabelRepository();

    const result = await repo.resolve('Trastorno del Espectro Autista');

    expect(result).toBe('uri://x');
    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining('FROM clickup_diagnosis_labels WHERE source = $1 AND label = $2 AND active'),
      ['clickup', 'Trastorno del Espectro Autista'],
    );
  });

  it('resolve() devolve null quando o rótulo NÃO tem linha — nunca lança', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const repo = new ClickUpDiagnosisLabelRepository();

    const result = await repo.resolve('Rótulo Desconhecido');

    expect(result).toBeNull();
  });

  it('usa a `source` do construtor — não hardcoded "clickup" na query', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const repo = new ClickUpDiagnosisLabelRepository('outro-source');

    await repo.resolve('X');

    expect(mockPoolQuery).toHaveBeenCalledWith(expect.any(String), ['outro-source', 'X']);
  });
});
