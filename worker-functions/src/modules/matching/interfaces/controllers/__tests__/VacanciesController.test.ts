/**
 * VacanciesController.test.ts — `GET /vacancies/:id` (spec 056 T4.3): `weekly_hours` derivado do
 * horário efetivo (do serviço, com `durationMinutes`) e `authorized_period` fora da resposta.
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
    weekly_hours: null,
    authorized_period: '2026-01/2026-06',
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

async function getData(row: Record<string, unknown>) {
  mockQuery.mockResolvedValue({ rows: [row] });
  const [req, res] = reqRes();
  await new VacanciesController().getVacancyById(req, res);
  return (res.json as jest.Mock).mock.calls[0][0].data;
}

describe('GET /vacancies/:id — weekly_hours derivado e sem authorized_period (056 T4.3)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('vaga de serviço com horário 40 h → weekly_hours 40 (coluna null é ignorada)', async () => {
    const schedule = [1, 2, 3, 4, 5].map((dayOfWeek) => ({
      dayOfWeek, startTime: '08:00', endTime: '16:00', durationMinutes: 480,
    }));
    const data = await getData(baseRow({ contracted_service_id: 'svc-1', schedule, weekly_hours: null }));
    expect(data.weekly_hours).toBe(40);
  });

  it('arredonda a 2 casas', async () => {
    const data = await getData(baseRow({ schedule: [{ dayOfWeek: 1, startTime: '08:00', durationMinutes: 100 }] }));
    expect(data.weekly_hours).toBe(1.67);
  });

  it('vaga legada sem schedule → weekly_hours da coluna', async () => {
    const data = await getData(baseRow({ schedule: null, weekly_hours: '12.50' }));
    expect(data.weekly_hours).toBe('12.50');
  });

  it('resposta sem authorized_period', async () => {
    const data = await getData(baseRow());
    expect(data).not.toHaveProperty('authorized_period');
  });
});
