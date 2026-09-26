/**
 * VacanciesController.stageCounts.test.ts
 *
 * P6 — `GET /api/admin/vacancies` (listVacancies) ganha `stageCounts` por linha,
 * carregado numa ÚNICA consulta por PÁGINA (loadStageCounts), não uma por vaga.
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

function reqRes(query: Record<string, string> = {}): [Request, Response] {
  const req = { query, body: {}, params: {} } as unknown as Request;
  const res = {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return [req, res];
}

function vagaRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'jp-a',
    case_number: 1,
    vacancy_number: 1,
    patient_first_name: 'Ana',
    patient_last_name: 'García',
    status: 'SEARCHING',
    is_draft: false,
    priority: 'NORMAL',
    dias_aberto: 3,
    convidados: 1,
    postulados: 1,
    confirmados: 0,
    selecionados: 0,
    faltantes: 1,
    ...overrides,
  };
}

describe('VacanciesController.listVacancies — stageCounts', () => {
  let controller: VacanciesController;

  beforeEach(() => {
    mockQuery.mockReset();
    controller = new VacanciesController();
  });

  it('chama query 3 vezes (total, vagas, stageCounts) e devolve stageCounts por linha', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ total: '2' }] }) // countQuery
      .mockResolvedValueOnce({
        rows: [vagaRow({ id: 'jp-a' }), vagaRow({ id: 'jp-b' })],
      }) // finalQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'jp-a', kind: 'wja', stage: 'INVITED', source: 'manual', messaged: false, n: 1 }],
      }); // loadStageCounts

    const [req, res] = reqRes();
    await controller.listVacancies(req, res);

    expect(mockQuery).toHaveBeenCalledTimes(3);

    const { data } = (res.json as jest.Mock).mock.calls[0][0];
    expect(data[0].stageCounts.INICIADO).toBe(1);
    expect(Object.values(data[1].stageCounts).every((n) => n === 0)).toBe(true);

    const [, thirdCallParams] = mockQuery.mock.calls[2];
    expect(thirdCallParams).toEqual([['jp-a', 'jp-b']]);
  });
});
