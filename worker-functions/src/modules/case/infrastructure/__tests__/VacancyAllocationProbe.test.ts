import { countVigenteForService, countVigenteForVacancy } from '../VacancyAllocationProbe';

const NOW = new Date('2026-10-21T02:30:00Z'); // 23:30 de 20/10 em Buenos Aires

function qStub(...results: Array<{ rows: unknown[] }>) {
  const query = jest.fn();
  for (const r of results) query.mockResolvedValueOnce(r);
  return { query };
}

describe('VacancyAllocationProbe', () => {
  it('countVigenteForVacancy: vaga sem serviço → 0 e só 1 query', async () => {
    const q = qStub({ rows: [] });

    const n = await countVigenteForVacancy(q as never, 'vac-1', NOW);

    expect(n).toBe(0);
    expect(q.query).toHaveBeenCalledTimes(1);
  });

  it('countVigenteForVacancy: today = operationDateOf(país) (20/10 em AR às 02:30Z), não a data UTC; SQL sem valid_from nem CURRENT_DATE', async () => {
    const q = qStub({ rows: [{ service_id: 'svc-1', country: 'AR' }] }, { rows: [] }, { rows: [{ n: 1 }] });

    await countVigenteForVacancy(q as never, 'vac-1', NOW);

    const [sql, params] = q.query.mock.calls[2];
    expect(params).toEqual(['svc-1', '2026-10-20']);
    expect(String(sql)).not.toMatch(/valid_from/);
    expect(String(sql)).not.toMatch(/CURRENT_DATE/);
  });

  it('countVigenteForVacancy: devolve a contagem do banco (3) e 0 quando não há linha', async () => {
    const tres = qStub({ rows: [{ service_id: 'svc-1', country: 'AR' }] }, { rows: [] }, { rows: [{ n: 3 }] });
    const zero = qStub({ rows: [{ service_id: 'svc-1', country: 'AR' }] }, { rows: [] }, { rows: [] });

    expect(await countVigenteForVacancy(tres as never, 'vac-1', NOW)).toBe(3);
    expect(await countVigenteForVacancy(zero as never, 'vac-1', NOW)).toBe(0);
    expect(await countVigenteForService(qStub({ rows: [{ n: 2 }] }) as never, 'svc-1', '2026-10-20')).toBe(2);
  });

  it("countVigenteForVacancy: toma pg_advisory_xact_lock(hashtext('itinerary:service:' || serviceId)) ANTES da contagem", async () => {
    const q = qStub({ rows: [{ service_id: 'svc-1', country: 'AR' }] }, { rows: [] }, { rows: [{ n: 0 }] });

    await countVigenteForVacancy(q as never, 'vac-1', NOW);

    const sqls = q.query.mock.calls.map(([sql]) => String(sql));
    expect(sqls[0]).toMatch(/FROM job_postings jp/);
    expect(sqls[1]).toMatch(/pg_advisory_xact_lock\(hashtext\('itinerary:service:' \|\| \$1::text\)\)/);
    expect(q.query.mock.calls[1][1]).toEqual(['svc-1']);
    expect(sqls[2]).toMatch(/SELECT count\(\*\)::int AS n/);
  });
});
