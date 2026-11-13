const mockQuery = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: mockQuery }) }) },
}));

import { AnalyticsRepository } from '../AnalyticsRepository';

const sqlDe = (i: number) => String(mockQuery.mock.calls[i][0]).replace(/\s+/g, ' ');

describe('AnalyticsRepository — recorte de realm (D664)', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [] });
  });

  it('T-F2a-67 analytics', async () => {
    const repo = new AnalyticsRepository();

    await repo.getWorkersIncompleteForVacancy('jp-1');
    await repo.getWorkersMissingDocuments();

    expect(sqlDe(0)).toContain(
      "COALESCE((SELECT w_realm_chk.is_test FROM workers w_realm_chk WHERE w_realm_chk.id = wro.worker_id), false) = COALESCE((SELECT jp_realm_chk.is_test FROM job_postings jp_realm_chk WHERE jp_realm_chk.id = $1), false)",
    );
    expect(sqlDe(1)).toContain(
      'NOT EXISTS (SELECT 1 FROM workers w_test_chk WHERE w_test_chk.id = worker_id AND w_test_chk.is_test = true)',
    );
  });
});
