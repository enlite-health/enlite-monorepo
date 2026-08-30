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
import { TEXTO_CLINICO, esperaSemVazamentoClinico } from '../../../__tests__/guardaVazamentoClinico';

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

/** Status que tornam uma vaga publicável — vai como parâmetro, não literal no SQL. */
const STATUS_PUBLICAVEL = ['ACTIVE', 'SEARCHING', 'SEARCHING_REPLACEMENT', 'RAPID_RESPONSE'];

/**
 * A LISTA DE PERMISSÃO da resposta pública, escrita por extenso de propósito.
 *
 * Antes o controller devolvia a linha crua (`res.json({ data: row })`), então o que a rota
 * expunha era decidido pelo SELECT — e uma coluna nova ia ao ar sozinha. Esta lista é o
 * contrato: acrescentar campo à resposta obriga a passar por aqui, e quem passar tem de
 * justificar que o campo não é clínico.
 */
const CAMPOS_PUBLICOS = [
  'id', 'case_number', 'vacancy_number', 'title', 'status', 'service_type',
  'required_professions', 'required_sex', 'age_range_min', 'age_range_max',
  'worker_attributes', 'schedule', 'schedule_days_hours', 'salary_text',
  'talentum_description', 'talentum_whatsapp_url', 'patient_zone', 'country', 'created_at',
].sort();

function makeVacancyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: VACANCY_ID,
    case_number: 42,
    vacancy_number: 1,
    title: 'CASO 42',
    status: 'SEARCHING',
    service_type: ['AT'],
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
    expect(params).toEqual([VACANCY_ID, STATUS_PUBLICAVEL]);

    expect(res.status).toHaveBeenCalledWith(200);
    const data = (res.json as jest.Mock).mock.calls[0][0].data;
    // A resposta é uma PROJEÇÃO explícita, não mais a linha crua do banco: o conjunto de
    // chaves é o contrato, e é ele que impede campo novo de vazar sem decisão.
    expect(Object.keys(data).sort()).toEqual(CAMPOS_PUBLICOS);
    expect(data.id).toBe(row.id);
    expect(data.title).toBe(row.title);
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
    expect(params).toEqual([42, 1, STATUS_PUBLICAVEL]);

    expect(res.status).toHaveBeenCalledWith(200);
    const data = (res.json as jest.Mock).mock.calls[0][0].data;
    expect(Object.keys(data).sort()).toEqual(CAMPOS_PUBLICOS);
    expect(data.case_number).toBe(row.case_number);
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
      // as duas colunas clínicas saíram desta lista em 25/08/2026 — ver a guarda de fronteira
      'p.service_type AS service_type',
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

  it('returns service_type (patient device/service array) in the response', async () => {
    const row = makeVacancyRow({ service_type: ['CAREGIVER'] });
    mockQuery.mockResolvedValueOnce({ rows: [row] });

    const [req, res] = mockReqRes({ id: VACANCY_ID });
    await controller.getById(req, res);

    const data = (res.json as jest.Mock).mock.calls[0][0].data;
    expect(data.service_type).toEqual(['CAREGIVER']);
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

    // ⚠️ INVERTIDO em 25/08/2026. Estava assim, e era a régua protegendo o defeito:
    //     // diagnosis exposed only as anonymized 'pathologies' alias
    //     expect(sql).toContain('p.diagnosis AS pathologies');
    // Apelido não anonimiza: medido, `patients.diagnosis` tem 156 valores distintos para 184
    // pacientes (85%) e saía junto de `patient_zone`. Quem consertasse a rota reprovava aqui.
    expect(sql).not.toMatch(/p\.diagnosis/);

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

  // ══════════════════════════════════════════════════════════════════════════
  // GUARDA DE FRONTEIRA (C3/C4 do parecer do `lex`, 25/08/2026)
  //
  // Estes testes NÃO afirmam sobre a lista de campos que eu lembrei de checar — foi assim que o
  // vazamento reincidiu três vezes no PR #249, cada vez por um caminho novo. Eles afirmam sobre
  // o que ATRAVESSA a fronteira: o corpo inteiro da resposta, serializado.
  //
  // ⚠️ O teste que existia aqui antes fazia `expect(sql).toContain('p.diagnosis AS pathologies')`,
  // com o comentário "diagnosis exposed only as anonymized 'pathologies' alias". Ele TRAVAVA o
  // defeito: quem consertasse reprovava. Apelido não é anonimização — medido, o campo tem 156
  // valores distintos para 184 pacientes.
  // ══════════════════════════════════════════════════════════════════════════
  describe('guarda de fronteira — dado clínico não atravessa', () => {
    it('o corpo da resposta não contém dado clínico, mesmo se o banco devolver a coluna', async () => {
      // A fixture carrega texto clínico REAL e finge que o banco devolveu as duas colunas
      // proibidas — é o cenário "alguém acrescentou a coluna ao SELECT e ninguém percebeu".
      // A projeção por lista de permissão tem de barrar, sem depender do SQL estar certo.
      const row = makeVacancyRow({
        diagnosis: TEXTO_CLINICO,
        pathologies: TEXTO_CLINICO,
        dependency_level: 'TOTAL',
      });
      mockQuery.mockResolvedValueOnce({ rows: [row] });

      const [req, res] = mockReqRes({ id: VACANCY_ID });
      await controller.getById(req, res);

      const body = (res.json as jest.Mock).mock.calls[0][0];
      esperaSemVazamentoClinico(body);
      expect(body.data).not.toHaveProperty('pathologies');
      expect(body.data).not.toHaveProperty('diagnosis');
      expect(body.data).not.toHaveProperty('dependency_level');
    });

    it('o SQL não pede as colunas clínicas', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [makeVacancyRow()] });
      const [req, res] = mockReqRes({ id: VACANCY_ID });
      await controller.getById(req, res);

      const [sql] = mockQuery.mock.calls[0];
      expect(sql).not.toMatch(/p\.diagnosis/);
      expect(sql).not.toMatch(/dependency_level/);
    });

    it('a rota só responde por vaga publicável — rascunho e status fechado não saem', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [makeVacancyRow()] });
      const [req, res] = mockReqRes({ id: VACANCY_ID });
      await controller.getById(req, res);

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toMatch(/is_draft\s*=\s*false/);
      expect(sql).toMatch(/status\s*=\s*ANY/);
      // A lista de status vai como PARÂMETRO — se virar literal no SQL, este teste segue
      // passando por engano, então checo o parâmetro e não só o texto.
      expect(params[params.length - 1]).toEqual(
        ['ACTIVE', 'SEARCHING', 'SEARCHING_REPLACEMENT', 'RAPID_RESPONSE'],
      );
    });

    it('o placeholder do status acompanha o formato do id (slug tem 2 params, uuid tem 1)', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [makeVacancyRow()] });
      const [req, res] = mockReqRes({ id: 'caso42-1' });
      await controller.getById(req, res);

      const [sql, params] = mockQuery.mock.calls[0];
      expect(params).toHaveLength(3);          // case_number, vacancy_number, status[]
      expect(sql).toMatch(/\$3::text\[\]/);
    });
  });
});
