const mockQuery = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: mockQuery }) }) },
}));

import { EncuadreQueryRepository } from '../EncuadreQueryRepository';

const sqlDe = (i: number) => String(mockQuery.mock.calls[i][0]).replace(/\s+/g, ' ');
const REALM_POR_VAGA =
  "COALESCE((SELECT w_realm_chk.is_test FROM workers w_realm_chk WHERE w_realm_chk.id = worker_id), false) = COALESCE((SELECT jp_realm_chk.is_test FROM job_postings jp_realm_chk WHERE jp_realm_chk.id = job_posting_id), false)";
const WORKER_NAO_TESTE =
  "NOT EXISTS (SELECT 1 FROM workers w_test_chk WHERE w_test_chk.id = e.worker_id AND w_test_chk.is_test = true)";

describe('EncuadreQueryRepository — recorte de realm (D664)', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [] });
  });

  it('T-F2a-67 encuadres por vaga e agregados', async () => {
    const repo = new EncuadreQueryRepository();

    await repo.countInvitedAndAttended('jp-1');
    await repo.countByResultado('jp-1');
    await repo.countAttended();
    await repo.countSelAndRemByCaseNumber('AR');

    expect(sqlDe(0)).toContain(REALM_POR_VAGA);
    expect(sqlDe(1)).toContain(REALM_POR_VAGA);
    expect(sqlDe(2)).toContain(WORKER_NAO_TESTE);
    expect(sqlDe(2)).toContain(
      'NOT EXISTS (SELECT 1 FROM job_postings jp_test_chk WHERE jp_test_chk.id = e.job_posting_id AND jp_test_chk.is_test = true)',
    );
    expect(sqlDe(3)).toContain(WORKER_NAO_TESTE);
    expect(sqlDe(3)).toContain('COALESCE(jp.is_test, false) = false');
  });
});
