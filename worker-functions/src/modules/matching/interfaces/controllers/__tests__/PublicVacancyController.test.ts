/**
 * PublicVacancyController.test.ts
 *
 * Cenários cobertos:
 *   1. 200 — vaga encontrada, retorna apenas campos não-sensíveis
 *   2. 404 — vaga não encontrada (zero rows)
 *   3. 404 — vaga soft-deleted (deleted_at IS NOT NULL) → query filtra, retorna 0 rows
 *   4. 500 — erro de banco de dados
 *   5. Dados sensíveis do paciente ausentes (nome, diagnóstico, insurance não expostos)
 */

const mockQuery = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({
        query: mockQuery,
      }),
    }),
  },
}));

import { PublicVacancyController } from '../PublicVacancyController';
import { Request, Response } from 'express';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockReqRes(params: Record<string, string> = {}): [Request, Response] {
  const req = { params, query: {}, body: {} } as unknown as Request;
  const res = {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return [req, res];
}

const VACANCY_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function makeVacancyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: VACANCY_ID,
    case_number: 42,
    vacancy_number: 1,
    title: 'CASO 42',
    status: 'SEARCHING',
    dependency_level: 'MODERADA',
    pathologies: ['TEA'],
    required_professions: ['psicopedagogo'],
    required_sex: null,
    age_range_min: 5,
    age_range_max: 12,
    worker_attributes: null,
    schedule: 'manana',
    schedule_days_hours: null,
    salary_text: '$1000/h',
    talentum_description: 'Buscamos AT con experiencia en TEA.',
    talentum_whatsapp_url: 'https://wa.me/link',
    country: 'AR',
    created_at: '2025-01-01T00:00:00Z',
    patient_zone: 'Palermo',
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PublicVacancyController.getById', () => {
  let controller: PublicVacancyController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new PublicVacancyController();
  });

  it('returns 200 with vacancy data when found by UUID', async () => {
    const row = makeVacancyRow();
    mockQuery.mockResolvedValueOnce({ rows: [row] });

    const [req, res] = mockReqRes({ id: VACANCY_ID });
    await controller.getById(req, res);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('jp.id = $1');
    expect(sql).toContain('jp.deleted_at IS NULL');
    expect(params).toEqual([VACANCY_ID]);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: row });
  });

  it('returns 200 with vacancy data when found by slug (caso{N}-{N})', async () => {
    const row = makeVacancyRow();
    mockQuery.mockResolvedValueOnce({ rows: [row] });

    const [req, res] = mockReqRes({ id: 'caso42-1' });
    await controller.getById(req, res);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('jp.case_number = $1');
    expect(sql).toContain('jp.vacancy_number = $2');
    expect(sql).toContain('jp.deleted_at IS NULL');
    expect(params).toEqual([42, 1]);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: row });
  });

  it('returns 404 when vacancy not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const [req, res] = mockReqRes({ id: VACANCY_ID });
    await controller.getById(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Vacancy not found' });
  });

  it('returns 404 for soft-deleted vacancy (query filters deleted_at)', async () => {
    // The WHERE clause includes deleted_at IS NULL, so the DB returns 0 rows
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const [req, res] = mockReqRes({ id: VACANCY_ID });
    await controller.getById(req, res);

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain('deleted_at IS NULL');
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 500 on database error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection refused'));

    const [req, res] = mockReqRes({ id: VACANCY_ID });
    await controller.getById(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Failed to fetch vacancy' });
  });

  it('SQL query selects all expected columns (catches missing column bugs)', async () => {
    const row = makeVacancyRow();
    mockQuery.mockResolvedValueOnce({ rows: [row] });

    const [req, res] = mockReqRes({ id: VACANCY_ID });
    await controller.getById(req, res);

    const [sql] = mockQuery.mock.calls[0];
    const expectedColumns = [
      'jp.id',
      'jp.case_number',
      'jp.vacancy_number',
      'jp.title',
      'jp.status',
      'p.dependency_level',
      'p.diagnosis AS pathologies',
      'jp.required_professions',
      'jp.required_sex',
      'jp.age_range_min',
      'jp.age_range_max',
      'jp.worker_attributes',
      'jp.schedule',
      'jp.schedule_days_hours',
      'jp.salary_text',
      'jp.talentum_description',
      'jp.talentum_whatsapp_url',
      'jp.country',
      'jp.created_at',
    ];

    for (const col of expectedColumns) {
      expect(sql).toContain(col);
    }
  });

  it('normalizes Gemini schedule format (array) to frontend format (object by day)', async () => {
    const geminiSchedule = [
      { dayOfWeek: 1, startTime: '09:00', endTime: '13:00' },
      { dayOfWeek: 1, startTime: '14:00', endTime: '17:00' },
      { dayOfWeek: 3, startTime: '10:00', endTime: '15:00' },
    ];
    const row = makeVacancyRow({ schedule: geminiSchedule });
    mockQuery.mockResolvedValueOnce({ rows: [row] });

    const [req, res] = mockReqRes({ id: VACANCY_ID });
    await controller.getById(req, res);

    const data = (res.json as jest.Mock).mock.calls[0][0].data;
    expect(data.schedule).toEqual({
      lunes: [
        { start: '09:00', end: '13:00' },
        { start: '14:00', end: '17:00' },
      ],
      miercoles: [{ start: '10:00', end: '15:00' }],
    });
  });

  it('passes through object schedule format (manual admin creation) as-is', async () => {
    const objectSchedule = { lunes: [{ start: '08:00', end: '12:00' }] };
    const row = makeVacancyRow({ schedule: objectSchedule });
    mockQuery.mockResolvedValueOnce({ rows: [row] });

    const [req, res] = mockReqRes({ id: VACANCY_ID });
    await controller.getById(req, res);

    const data = (res.json as jest.Mock).mock.calls[0][0].data;
    expect(data.schedule).toEqual(objectSchedule);
  });

  it('normalizes null/undefined schedule to null', async () => {
    const row = makeVacancyRow({ schedule: null });
    mockQuery.mockResolvedValueOnce({ rows: [row] });

    const [req, res] = mockReqRes({ id: VACANCY_ID });
    await controller.getById(req, res);

    const data = (res.json as jest.Mock).mock.calls[0][0].data;
    expect(data.schedule).toBeNull();
  });

  it('does not expose sensitive patient fields', async () => {
    const row = makeVacancyRow();
    mockQuery.mockResolvedValueOnce({ rows: [row] });

    const [req, res] = mockReqRes({ id: VACANCY_ID });
    await controller.getById(req, res);

    const [sql] = mockQuery.mock.calls[0];

    // PII fields must not appear in the SELECT
    expect(sql).not.toMatch(/p\.first_name/);
    expect(sql).not.toMatch(/p\.last_name/);
    expect(sql).not.toMatch(/p\.insurance/);

    // diagnosis exposed only as anonymized 'pathologies' alias — not the raw name/surname
    expect(sql).toContain('p.diagnosis AS pathologies');

    // Coarse location: bairro + cidade + província (estruturado de pa.*, fallback pra texto-livre)
    expect(sql).toContain('pa.neighborhood');
    expect(sql).toContain('p.zone_neighborhood');
    expect(sql).toContain('pa.city');
    expect(sql).toContain('pa.state');
    expect(sql).toContain('patient_zone');

    // Endereço completo nunca é exposto
    expect(sql).not.toMatch(/pa\.address_formatted/);
    expect(sql).not.toMatch(/pa\.address_raw/);
    expect(sql).not.toMatch(/pa\.complement/);
    expect(sql).not.toMatch(/pa\.lat/);
    expect(sql).not.toMatch(/pa\.lng/);
  });
});
