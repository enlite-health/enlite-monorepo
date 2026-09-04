const mockPoolQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({ query: mockPoolQuery }) }),
  },
}));

import { ClickUpDiagnosisRejectionRepository } from '../ClickUpDiagnosisRejectionRepository';

describe('ClickUpDiagnosisRejectionRepository', () => {
  beforeEach(() => mockPoolQuery.mockReset());

  it('recordUnmapped() faz upsert em patient_source_label_rejections com reason=unmapped e o campo "Tipo de Patología"', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const repo = new ClickUpDiagnosisRejectionRepository();

    await repo.recordUnmapped('pat-1', 'Rótulo Nunca Visto');

    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining("reason, source)\n       VALUES ($1, $2, $3, 'unmapped', $4)"),
      ['pat-1', 'Tipo de Patología', 'Rótulo Nunca Visto', 'clickup'],
    );
    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (patient_id, field_name, raw_label, reason) DO UPDATE'),
      expect.any(Array),
    );
  });

  it('usa a `source` do construtor', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const repo = new ClickUpDiagnosisRejectionRepository('backfill');

    await repo.recordUnmapped('pat-2', 'X');

    expect(mockPoolQuery).toHaveBeenCalledWith(expect.any(String), ['pat-2', 'Tipo de Patología', 'X', 'backfill']);
  });
});
