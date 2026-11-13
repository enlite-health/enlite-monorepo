import { EnquadreEventRepository } from '../EnquadreEventRepository';

describe('EnquadreEventRepository — recorte de realm (D664)', () => {
  it('T-F2a-66 convocaveis', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };

    await new EnquadreEventRepository().listAvailableWorkers(client as never, 'jp-1', null);

    const sql = String(client.query.mock.calls[0][0]).replace(/\s+/g, ' ');
    expect(sql).toContain(
      "COALESCE((SELECT w_realm_chk.is_test FROM workers w_realm_chk WHERE w_realm_chk.id = w.id), false) = COALESCE((SELECT jp_realm_chk.is_test FROM job_postings jp_realm_chk WHERE jp_realm_chk.id = wja.job_posting_id), false)",
    );
    expect(sql).not.toContain('COALESCE(w.is_test, false) = false');
  });
});
