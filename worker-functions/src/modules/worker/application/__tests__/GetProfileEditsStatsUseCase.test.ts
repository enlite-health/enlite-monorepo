import { GetProfileEditsStatsUseCase } from '../GetProfileEditsStatsUseCase';
import { workerNotTestSql } from '@shared/database/testRealmSql';
import type { Pool } from 'pg';

function makePool(rows: unknown[]) {
  return { query: jest.fn().mockResolvedValue({ rows }) };
}

describe('GetProfileEditsStatsUseCase', () => {
  it('agrega contagem por fonte e soma o total', async () => {
    const pool = makePool([
      { source: 'worker_self', edits: '12', workers: '5', last_edit_at: new Date('2026-08-05T10:00:00.000Z') },
      { source: 'luz_conversation', edits: '4', workers: '2', last_edit_at: new Date('2026-08-04T09:00:00.000Z') },
    ]);
    const uc = new GetProfileEditsStatsUseCase(pool as unknown as Pool);

    const result = await uc.execute({ sinceDays: 30 });

    expect(result).toEqual({
      sinceDays: 30,
      totalEdits: 16,
      bySource: [
        {
          source: 'worker_self',
          edits: 12,
          workers: 5,
          lastEditAt: '2026-08-05T10:00:00.000Z',
        },
        {
          source: 'luz_conversation',
          edits: 4,
          workers: 2,
          lastEditAt: '2026-08-04T09:00:00.000Z',
        },
      ],
    });
    // janela parametrizada (sem interpolação de string no SQL)
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('make_interval'), [30]);
  });

  it('período vazio → total 0 e lista vazia (não explode)', async () => {
    const pool = makePool([]);
    const uc = new GetProfileEditsStatsUseCase(pool as unknown as Pool);

    const result = await uc.execute({ sinceDays: 7 });

    expect(result).toEqual({ sinceDays: 7, totalEdits: 0, bySource: [] });
  });

  it("normaliza o legado changed_by='luz' via CASE no SQL", async () => {
    const pool = makePool([]);
    const uc = new GetProfileEditsStatsUseCase(pool as unknown as Pool);
    await uc.execute({ sinceDays: 30 });

    const sql = String(pool.query.mock.calls[0][0]);
    expect(sql).toContain("WHEN changed_by = 'luz' THEN 'luz_conversation'");
  });

  it('T-F2b-29 worker de teste (is_test) fica fora da contagem, pelo dono do recorte (D664, D665)', async () => {
    const pool = makePool([]);
    const uc = new GetProfileEditsStatsUseCase(pool as unknown as Pool);
    await uc.execute({ sinceDays: 30 });

    const sql = String(pool.query.mock.calls[0][0]).replace(/\s+/g, ' ');
    expect(sql).toContain('FROM worker_profile_changes_audit a WHERE ');
    expect(sql).toContain(`AND ${workerNotTestSql('a.worker_id')} GROUP BY 1`);
  });
});
