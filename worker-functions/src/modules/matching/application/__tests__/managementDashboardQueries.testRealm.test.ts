import {
  workerCadastrosQuery,
  funnelLegadoQuery,
  esperandoAgendaQuery,
  bloqueadosQuery,
  encuadresSemanaQuery,
} from '../managementDashboardQueries';

const WNT = (x: string) =>
  `NOT EXISTS (SELECT 1 FROM workers w_test_chk WHERE w_test_chk.id = ${x} AND w_test_chk.is_test = true)`;
const VNT = (x: string) =>
  `NOT EXISTS (SELECT 1 FROM job_postings jp_test_chk WHERE jp_test_chk.id = ${x} AND jp_test_chk.is_test = true)`;

function mockDb() {
  return { query: jest.fn().mockResolvedValue({ rows: [] }) };
}

describe('managementDashboardQueries — worker de teste fora da Gestão à Vista (D664)', () => {
  it('T-F2a-68 gestao a vista', async () => {
    const db = mockDb();

    await workerCadastrosQuery(db as never, ['AR']);
    await funnelLegadoQuery(db as never, ['AR']);
    await esperandoAgendaQuery(db as never, ['AR']);
    await bloqueadosQuery(db as never, ['AR']);
    await encuadresSemanaQuery(db as never, ['AR']);

    const sqls = db.query.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' '));
    expect(sqls[0]).toContain('COALESCE(w.is_test, false) = false');
    expect(sqls[1]).toContain(WNT('wja.worker_id'));
    expect(sqls[1]).toContain(VNT('wja.job_posting_id'));
    expect(sqls[2]).toContain('COALESCE(w.is_test, false) = false');
    expect(sqls[3]).toContain('COALESCE(lw.is_test, false) = false');
    expect(sqls[4]).toContain(WNT('wja.worker_id'));
    expect(sqls[4]).toContain(VNT('wja.job_posting_id'));
    expect(sqls[4]).toContain(WNT('p.worker_id'));
    expect(sqls[4]).toContain(VNT('p.job_posting_id'));
  });
});
