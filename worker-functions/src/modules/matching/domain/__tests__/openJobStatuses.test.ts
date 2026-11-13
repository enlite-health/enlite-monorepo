import { LIVE_JOB_POSTING_SQL } from '../openJobStatuses';

describe('LIVE_JOB_POSTING_SQL', () => {
  it('T-F2a-65 vaga de teste não é vaga viva', () => {
    expect(LIVE_JOB_POSTING_SQL).toContain('COALESCE(jp.is_test, false) = false');
    expect(LIVE_JOB_POSTING_SQL).toContain('jp.is_draft = false');
  });
});
