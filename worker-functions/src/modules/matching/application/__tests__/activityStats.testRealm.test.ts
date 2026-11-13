import { GetFunnelActivityStatsUseCase } from '../GetFunnelActivityStatsUseCase';
import { GetRecruiterActivityPerPersonUseCase } from '../GetRecruiterActivityPerPersonUseCase';

const NOT_TEST_ACOES =
  "NOT EXISTS (SELECT 1 FROM workers w_test_chk WHERE w_test_chk.id = acoes.worker_id AND w_test_chk.is_test = true)";

describe('atividade de recrutamento — worker de teste fora (D664)', () => {
  it('T-F2a-68 atividade do funil', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });

    await new GetFunnelActivityStatsUseCase({ query } as never).execute({ sinceDays: 7 });

    expect(String(query.mock.calls[0][0]).replace(/\s+/g, ' ')).toContain(NOT_TEST_ACOES);
  });

  it('T-F2a-68 atividade por recrutador', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });

    await new GetRecruiterActivityPerPersonUseCase({ query } as never).execute({
      weeks: 4,
      now: new Date('2026-11-13T12:00:00Z'),
    });

    expect(String(query.mock.calls[0][0]).replace(/\s+/g, ' ')).toContain(NOT_TEST_ACOES);
  });
});
