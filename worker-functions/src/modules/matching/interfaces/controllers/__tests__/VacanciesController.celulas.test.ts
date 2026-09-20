/**
 * F2/C3 — `GET /api/admin/vacancies/:id` sob as células.
 *
 * ⚠️ Esta rota é a EXCEÇÃO das quatro: nome e telefone do prestador saem do SQL
 * já em texto claro, dentro do `json_agg` dos encuadres (`e.worker_raw_name`,
 * `COALESCE(w.phone, e.worker_raw_phone)`). Não há KMS a economizar aqui, então
 * o espião com 0 chamadas não é prova de nada — a prova é a FRONTEIRA: o dado
 * não aparece em NENHUM lugar do corpo da resposta.
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
import { NOME_REDIGIDO, CELL_WORKER_CONTACT_READ } from '@modules/identity/permissions';

const NOME = 'María González';
const TELEFONE = '+5491133445566';

function reqRes(cells: string[] | null): [Request, Response] {
  const req = { params: { id: 'jp-1' }, body: {}, query: {} } as unknown as Request;
  if (cells !== null) (req as Request & { permissionCells?: string[] }).permissionCells = cells;
  const res = {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return [req, res];
}

function prepararVaga() {
  mockQuery.mockResolvedValue({
    rows: [{
      id: 'jp-1',
      vacancy_number: 42,
      schedule: null,
      patient_first_name: 'Paciente',
      service_type: null,
      required_professions: null,
      social_short_links: null,
      encuadres: [{
        id: 'e-1',
        worker_name: NOME,
        worker_phone: TELEFONE,
        interview_date: null,
        resultado: 'SELECCIONADO',
        attended: true,
        rejection_reason_category: null,
        rejection_reason: null,
      }],
      publications: null,
    }],
  });
}

function encuadres(res: Response) {
  return (res.json as jest.Mock).mock.calls[0][0].data.encuadres;
}

describe('GET /vacancies/:id — a projeção vale mesmo sem KMS no caminho', () => {
  beforeEach(() => jest.clearAllMocks());

  it('sem worker_contact:read, o nome e o telefone NÃO atravessam a fronteira', async () => {
    prepararVaga();
    const [req, res] = reqRes(['vacancy:read']);
    await new VacanciesController().getVacancyById(req, res);

    const corpo = JSON.stringify((res.json as jest.Mock).mock.calls[0][0]);
    expect(corpo).not.toContain(NOME);
    expect(corpo).not.toContain(TELEFONE);
    expect(encuadres(res)[0]).toMatchObject({
      id: 'e-1', worker_name: NOME_REDIGIDO, worker_phone: null, resultado: 'SELECCIONADO',
    });
  });

  it('com a célula de contato, sai como antes', async () => {
    prepararVaga();
    const [req, res] = reqRes(['vacancy:read', CELL_WORKER_CONTACT_READ]);
    await new VacanciesController().getVacancyById(req, res);

    expect(encuadres(res)[0]).toMatchObject({ worker_name: NOME, worker_phone: TELEFONE });
  });

  it('engine que não decidiu (`null`) devolve o que a rota já devolvia — D113', async () => {
    prepararVaga();
    const [req, res] = reqRes(null);
    await new VacanciesController().getVacancyById(req, res);

    expect(encuadres(res)[0]).toMatchObject({ worker_name: NOME, worker_phone: TELEFONE });
  });

  it('vaga sem encuadre nenhum (`null` do json_agg) não quebra', async () => {
    mockQuery.mockResolvedValue({
      rows: [{
        id: 'jp-1', vacancy_number: 42, schedule: null, encuadres: null, publications: null,
        service_type: null, required_professions: null, social_short_links: null,
      }],
    });
    const [req, res] = reqRes([]);
    await new VacanciesController().getVacancyById(req, res);

    expect((res.json as jest.Mock).mock.calls[0][0].success).toBe(true);
    expect(encuadres(res)).toBeNull();
  });

  it('o resto da vaga sai inteiro — redigir o prestador não pode esvaziar a tela', async () => {
    prepararVaga();
    const [req, res] = reqRes([]);
    await new VacanciesController().getVacancyById(req, res);

    const data = (res.json as jest.Mock).mock.calls[0][0].data;
    expect(data).toMatchObject({ id: 'jp-1', vacancy_number: 42 });
    expect(data.encuadres).toHaveLength(1);
  });
});
