import {
  excludeTestWorkerSql,
  workerNotTestSql,
  excludeTestVacancySql,
  vacancyNotTestSql,
  sameRealmAsVacancySql,
} from '../testRealmSql';

describe('testRealmSql', () => {
  it('T-F2a-65 excludeTestWorkerSql', () => {
    expect(excludeTestWorkerSql()).toBe('COALESCE(w.is_test, false) = false');
    expect(excludeTestWorkerSql('lw')).toBe('COALESCE(lw.is_test, false) = false');
  });

  it('T-F2a-65 workerNotTestSql', () => {
    const sql = workerNotTestSql('wba.worker_id');
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM workers w_test_chk');
    expect(sql).toContain('w_test_chk.id = wba.worker_id');
    expect(sql).toContain('w_test_chk.is_test = true');
  });

  it('T-F2a-65 excludeTestVacancySql e vacancyNotTestSql', () => {
    expect(excludeTestVacancySql()).toBe('COALESCE(jp.is_test, false) = false');
    expect(excludeTestVacancySql('x')).toBe('COALESCE(x.is_test, false) = false');
    const sql = vacancyNotTestSql('wja.job_posting_id');
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM job_postings jp_test_chk');
    expect(sql).toContain('jp_test_chk.id = wja.job_posting_id');
    expect(sql).toContain('jp_test_chk.is_test = true');
  });

  it('T-F2a-65 sameRealmAsVacancySql null-safe', () => {
    const sql = sameRealmAsVacancySql('wja.worker_id', 'wja.job_posting_id');
    expect(sql).toContain('COALESCE((SELECT w_realm_chk.is_test');
    expect(sql).toContain('w_realm_chk.id = wja.worker_id), false)');
    expect(sql).toContain('COALESCE((SELECT jp_realm_chk.is_test');
    expect(sql).toContain('jp_realm_chk.id = wja.job_posting_id), false)');
  });
});
