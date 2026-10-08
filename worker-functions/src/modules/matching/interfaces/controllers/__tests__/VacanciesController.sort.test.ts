/**
 * VacanciesController.sort.test.ts
 *
 * Spec 046 F3 — GET /api/admin/vacancies aceita `sort`/`order` (A10-A13, A19).
 * Sem `sort`: SQL `created_at DESC, id ASC` + LIMIT/OFFSET (como hoje).
 * Com `sort`: carrega TODAS as vagas filtradas, calcula contagens/última ação com as
 * MESMAS funções do payload, ordena em memória (NULLS LAST, desempate por id) e pagina.
 */

const mockQuery = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({ query: mockQuery }),
    }),
  },
}));

import { Request, Response } from 'express';
import { VacanciesController } from '../VacanciesController';

function reqRes(query: Record<string, unknown> = {}): [Request, Response] {
  const req = { query, body: {}, params: {} } as unknown as Request;
  const res = {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return [req, res];
}

function vagaRow(id: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id, case_number: 1, case_ordinal: 1, vacancy_number: 1,
    patient_first_name: 'Ana', patient_last_name: 'García',
    status: 'SEARCHING', is_draft: false, dias_aberto: 3,
    convidados: 1, postulados: 1, selecionados: 0, faltantes: 1,
    ...overrides,
  };
}

const wja = (id: string, stage: string, n: number) =>
  ({ id, kind: 'wja', stage, source: 'manual', messaged: false, n, dismissed: false });

/** Mocka as 4 consultas do caminho com sort: total, todas as vagas, stageCounts, atividade. */
function mockSortPath(rows: unknown[], stageRows: unknown[], activityRows: unknown[] = []) {
  mockQuery
    .mockResolvedValueOnce({ rows: [{ total: String(rows.length) }] })
    .mockResolvedValueOnce({ rows })
    .mockResolvedValueOnce({ rows: stageRows })
    .mockResolvedValueOnce({ rows: activityRows });
}

const ids = (res: Response) => (res.json as jest.Mock).mock.calls[0][0].data.map((v: { id: string }) => v.id);

describe('VacanciesController.listVacancies — sort (spec 046 F3)', () => {
  let controller: VacanciesController;
  beforeEach(() => {
    mockQuery.mockReset();
    controller = new VacanciesController();
  });

  it('A12: sem sort, SQL é created_at DESC + desempate jp.id ASC, com LIMIT/OFFSET', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ total: '1' }] })
      .mockResolvedValueOnce({ rows: [vagaRow('a')] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const [req, res] = reqRes({ limit: '5', offset: '10' });
    await controller.listVacancies(req, res);
    const sql = mockQuery.mock.calls[1][0] as string;
    expect(sql).toMatch(/ORDER BY jp\.created_at DESC, jp\.id ASC\s+LIMIT \$\d+ OFFSET \$\d+/);
    expect(mockQuery.mock.calls[1][1].slice(-2)).toEqual([5, 10]);
  });

  it.each([
    [{ sort: 'case' }], [{ sort: 'status' }], [{ sort: 'nome' }], [{ sort: 'created_at;drop' }],
    [{ sort: 'completed', order: 'asc nulls first' }], [{ sort: 'completed', order: 'sideways' }],
  ])('A11: %j -> 400 sem tocar o banco', async (q) => {
    const [req, res] = reqRes(q);
    await controller.listVacancies(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('A10: sort=completed&order=desc ordena a lista INTEIRA e a página 2 continua a 1', async () => {
    const rows = ['a', 'b', 'c', 'd', 'e'].map((i) => vagaRow(i));
    const stage = [wja('a', 'COMPLETED', 1), wja('b', 'COMPLETED', 5), wja('c', 'COMPLETED', 3),
      wja('d', 'COMPLETED', 4), wja('e', 'COMPLETED', 2)];
    mockSortPath(rows, stage);
    const [r1, p1] = reqRes({ sort: 'completed', order: 'desc', limit: '2', offset: '0' });
    await controller.listVacancies(r1, p1);
    mockSortPath(rows, stage);
    const [r2, p2] = reqRes({ sort: 'completed', order: 'desc', limit: '2', offset: '2' });
    await controller.listVacancies(r2, p2);
    expect(ids(p1)).toEqual(['b', 'd']);
    expect(ids(p2)).toEqual(['c', 'e']);
    expect(mockQuery.mock.calls[1][0]).not.toMatch(/LIMIT/);
    expect((p1.json as jest.Mock).mock.calls[0][0].total).toBe(5);
  });

  it('A10: sort=lastActionAt desc, NULLS LAST nas duas direções', async () => {
    const rows = ['a', 'b', 'c'].map((i) => vagaRow(i));
    const act = [
      { id: 'a', last_action_at: new Date('2026-09-01T00:00:00Z') },
      { id: 'c', last_action_at: new Date('2026-10-01T00:00:00Z') },
    ];
    mockSortPath(rows, [], act);
    const [r1, p1] = reqRes({ sort: 'lastActionAt', order: 'desc' });
    await controller.listVacancies(r1, p1);
    mockSortPath(rows, [], act);
    const [r2, p2] = reqRes({ sort: 'lastActionAt', order: 'asc' });
    await controller.listVacancies(r2, p2);
    expect(ids(p1)).toEqual(['c', 'a', 'b']);
    expect(ids(p2)).toEqual(['a', 'c', 'b']);
  });

  it('A13: empate na chave desempata por id, nas duas direções', async () => {
    const rows = ['c', 'a', 'b'].map((i) => vagaRow(i));
    mockSortPath(rows, []);
    const [r1, p1] = reqRes({ sort: 'completed', order: 'desc' });
    await controller.listVacancies(r1, p1);
    mockSortPath(rows, []);
    const [r2, p2] = reqRes({ sort: 'completed', order: 'asc' });
    await controller.listVacancies(r2, p2);
    expect(ids(p1)).toEqual(['a', 'b', 'c']);
    expect(ids(p2)).toEqual(['a', 'b', 'c']);
  });

  it('A19: pre_screening soma PRE_SCREENING+IN_PROGRESS e o valor que ordena é o do payload', async () => {
    const rows = ['a', 'b'].map((i) => vagaRow(i));
    const stage = [wja('a', 'PRE_SCREENING', 1), wja('a', 'IN_PROGRESS', 1), wja('b', 'PRE_SCREENING', 3)];
    mockSortPath(rows, stage);
    const [req, res] = reqRes({ sort: 'preScreening', order: 'desc' });
    await controller.listVacancies(req, res);
    const data = (res.json as jest.Mock).mock.calls[0][0].data;
    expect(data.map((v: { id: string }) => v.id)).toEqual(['b', 'a']);
    const soma = (v: { stageCounts: Record<string, number> }) => v.stageCounts.PRE_SCREENING + v.stageCounts.IN_PROGRESS;
    expect(data.map(soma)).toEqual([3, 2]);
  });

  it('postulados/faltantes ordenam pelo NÚMERO (string com padStart), faltantes null por último', async () => {
    const rows = [
      vagaRow('a', { postulados: 9, faltantes: 10 }),
      vagaRow('b', { postulados: 10, faltantes: 2 }),
      vagaRow('c', { postulados: 2, faltantes: null }),
    ];
    mockSortPath(rows, []);
    const [r1, p1] = reqRes({ sort: 'postulados', order: 'desc' });
    await controller.listVacancies(r1, p1);
    mockSortPath(rows, []);
    const [r2, p2] = reqRes({ sort: 'faltantes', order: 'desc' });
    await controller.listVacancies(r2, p2);
    expect(ids(p1)).toEqual(['b', 'a', 'c']);
    expect(ids(p2)).toEqual(['a', 'b', 'c']);
  });
});
