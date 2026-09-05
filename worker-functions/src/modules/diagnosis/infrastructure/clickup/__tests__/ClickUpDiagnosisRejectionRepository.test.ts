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

  // ── migration 329: a recusa SEM valor ────────────────────────────────────────────────────
  it('recordUnreadable() grava reason=unreadable com raw_label NULO — o valor não entra', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const repo = new ClickUpDiagnosisRejectionRepository();

    await repo.recordUnreadable('pat-3');

    const [sql, params] = mockPoolQuery.mock.calls[0];
    expect(sql).toContain("VALUES ($1, $2, NULL, 'unreadable', $3)");
    // 3 parâmetros, e nenhum deles é valor de paciente: id, nome do CAMPO e a origem.
    expect(params).toEqual(['pat-3', 'Tipo de Patología', 'clickup']);
  });

  it('recordUnreadable() mira o índice PARCIAL da 329 — senão o re-sync duplicaria a linha', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await new ClickUpDiagnosisRejectionRepository().recordUnreadable('pat-4');

    // `uq_..._value` inclui raw_label, e em btree NULO é DISTINTO de nulo: sem o `WHERE
    // raw_label IS NULL` o ON CONFLICT nunca dispararia (defeito 8 da migration 304).
    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (patient_id, field_name, reason) WHERE raw_label IS NULL DO UPDATE'),
      expect.any(Array),
    );
    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining('occurrences  = patient_source_label_rejections.occurrences + 1'),
      expect.any(Array),
    );
  });

  it('recordUnreadable() usa a `source` do construtor', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await new ClickUpDiagnosisRejectionRepository('backfill').recordUnreadable('pat-5');

    expect(mockPoolQuery).toHaveBeenCalledWith(expect.any(String), ['pat-5', 'Tipo de Patología', 'backfill']);
  });
});
