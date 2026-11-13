import { GetWorkerStatsUseCase } from '../GetWorkerStatsUseCase';

describe('GetWorkerStatsUseCase', () => {
  it('agrega totais, status e etapas de funil a partir das 3 queries', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ total: 7093, today: 12, last7: 84 }] })
      .mockResolvedValueOnce({
        rows: [
          { status: 'INCOMPLETE_REGISTER', count: 6906 },
          { status: 'REGISTERED', count: 187 },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { stage: 'PRE_SCREENING', count: 5000 },
          { stage: 'POSTULATED', count: 300 },
        ],
      });
    const useCase = new GetWorkerStatsUseCase({ query } as never);

    const result = await useCase.execute();

    expect(result).toEqual({
      totalWorkers: 7093,
      byStatus: { INCOMPLETE_REGISTER: 6906, REGISTERED: 187 },
      applicationsByFunnelStage: { PRE_SCREENING: 5000, POSTULATED: 300 },
      registeredToday: 12,
      registeredLast7Days: 84,
    });
    // Nenhuma das queries toca colunas encriptadas (zero PII)
    for (const call of query.mock.calls as [string][]) {
      expect(call[0]).not.toMatch(/_encrypted/);
    }
  });

  it('etapa null vira UNKNOWN', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ total: 1, today: 0, last7: 0 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ stage: null, count: 3 }] });
    const useCase = new GetWorkerStatsUseCase({ query } as never);

    const result = await useCase.execute();
    expect(result.applicationsByFunnelStage).toEqual({ UNKNOWN: 3 });
  });

  it('T-F2a-68 stats de prestador', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ total: 1, today: 0, last7: 0 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await new GetWorkerStatsUseCase({ query } as never).execute();

    const sqls = (query.mock.calls as [string][]).map((c) => c[0].replace(/\s+/g, ' '));
    expect(sqls[0]).toContain('COALESCE(workers.is_test, false) = false');
    expect(sqls[1]).toContain('COALESCE(workers.is_test, false) = false');
    expect(sqls[2]).toContain("NOT EXISTS (SELECT 1 FROM workers w_test_chk WHERE w_test_chk.id = worker_job_applications.worker_id AND w_test_chk.is_test = true)");
    expect(sqls[2]).toContain("NOT EXISTS (SELECT 1 FROM job_postings jp_test_chk WHERE jp_test_chk.id = worker_job_applications.job_posting_id AND jp_test_chk.is_test = true)");
  });
});
