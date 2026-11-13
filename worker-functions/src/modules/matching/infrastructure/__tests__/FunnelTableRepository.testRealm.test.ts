const mockQuery = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: mockQuery }) }) },
}));

import { FunnelTableRepository } from '../FunnelTableRepository';

const REALM_DE_WJA =
  "COALESCE((SELECT w_realm_chk.is_test FROM workers w_realm_chk WHERE w_realm_chk.id = wja.worker_id), false) = COALESCE((SELECT jp_realm_chk.is_test FROM job_postings jp_realm_chk WHERE jp_realm_chk.id = wja.job_posting_id), false)";
const REALM_DE_WBA =
  "COALESCE((SELECT w_realm_chk.is_test FROM workers w_realm_chk WHERE w_realm_chk.id = wba.worker_id), false) = COALESCE((SELECT jp_realm_chk.is_test FROM job_postings jp_realm_chk WHERE jp_realm_chk.id = wba.job_posting_id), false)";

describe('FunnelTableRepository — recorte de realm (D664)', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [] });
  });

  it('T-F2a-66 funnel-table candidaturas', async () => {
    await new FunnelTableRepository().fetchRawRows('jp-1');

    const sql = String(mockQuery.mock.calls[0][0]).replace(/\s+/g, ' ');
    expect(sql).toContain(REALM_DE_WJA);
    expect(sql).not.toContain('COALESCE(w.is_test, false) = false');
  });

  it('T-F2a-66 funnel-table bloqueados', async () => {
    await new FunnelTableRepository().fetchBlockedRawRows('jp-1');

    const sql = String(mockQuery.mock.calls[0][0]).replace(/\s+/g, ' ');
    expect(sql).toContain(REALM_DE_WBA);
    expect(sql).not.toContain('COALESCE(w.is_test, false) = false');
  });
});
