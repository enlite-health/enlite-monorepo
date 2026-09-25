/**
 * VacanciesController.lockedFields.test.ts — `GET /vacancies/:id` sob F3/fase-1
 * (`completar-vacante-em-rascunho`): `locked_fields` derivado de
 * `contracted_service_id`, e `updated_at` presente no payload (item 2 do
 * "O que implementa" de fase-1.md).
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
import { SOURCE_LOCKED_FIELDS } from '../vacancyCrudHelpers';

function reqRes(): [Request, Response] {
  const req = { params: { id: 'jp-1' }, body: {}, query: {} } as unknown as Request;
  const res = {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return [req, res];
}

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'jp-1',
    vacancy_number: 42,
    schedule: null,
    patient_first_name: 'Paciente',
    service_type: null,
    required_professions: null,
    social_short_links: null,
    encuadres: null,
    publications: null,
    updated_at: '2026-09-24T12:00:00.000Z',
    contracted_service_id: null,
    ...overrides,
  };
}

describe('GET /vacancies/:id — locked_fields (F3, fase 1)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('contracted_service_id preenchido (vaga do foguete) → locked_fields = SOURCE_LOCKED_FIELDS (os 8 nomes)', async () => {
    mockQuery.mockResolvedValue({ rows: [baseRow({ contracted_service_id: 'svc-1' })] });
    const [req, res] = reqRes();

    await new VacanciesController().getVacancyById(req, res);

    const data = (res.json as jest.Mock).mock.calls[0][0].data;
    expect(data.locked_fields).toEqual([...SOURCE_LOCKED_FIELDS]);
    expect(data.locked_fields).toHaveLength(8);
  });

  it('contracted_service_id NULL (vaga criada direto, sem serviço) → locked_fields = []', async () => {
    mockQuery.mockResolvedValue({ rows: [baseRow({ contracted_service_id: null })] });
    const [req, res] = reqRes();

    await new VacanciesController().getVacancyById(req, res);

    const data = (res.json as jest.Mock).mock.calls[0][0].data;
    expect(data.locked_fields).toEqual([]);
  });

  it('updated_at do banco atravessa a fronteira intacto (não é derrubado por whitelist/mapper)', async () => {
    mockQuery.mockResolvedValue({ rows: [baseRow({ updated_at: '2026-09-24T15:30:00.000Z' })] });
    const [req, res] = reqRes();

    await new VacanciesController().getVacancyById(req, res);

    const data = (res.json as jest.Mock).mock.calls[0][0].data;
    expect(data.updated_at).toBe('2026-09-24T15:30:00.000Z');
  });
});
