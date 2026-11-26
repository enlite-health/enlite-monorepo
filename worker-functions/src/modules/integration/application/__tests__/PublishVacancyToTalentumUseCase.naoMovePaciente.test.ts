/**
 * PublishVacancyToTalentumUseCase.naoMovePaciente.test.ts
 *
 * estado-automatico-do-paciente, D1: o envio à Talentum NÃO move o paciente (o gancho do lançamento, DX-6.1, foi apagado —
 * o foguete é o único gatilho de Búsqueda). Prova pelas queries: depois de BEGIN → UPDATE job_postings → COMMIT o publish
 * resolve com o resultado e NENHUMA query toca `patients` nem `app.change_source`; recusa da Talentum e `unpublish` idem.
 */

// ── Mocks (antes dos imports) ────────────────────────────────────

const mockQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();
const mockConnect = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({
        query: mockQuery,
        connect: mockConnect,
      }),
    }),
  },
}));

const mockCreatePrescreening = jest.fn();
const mockGetPrescreening = jest.fn();
const mockDeletePrescreening = jest.fn();
const mockTalentumCreate = jest.fn();
jest.mock('../../infrastructure/TalentumApiClient', () => ({
  TalentumApiClient: {
    create: (...args: unknown[]) => mockTalentumCreate(...args),
  },
}));

// ── Imports ──────────────────────────────────────────────────────

import { PublishVacancyToTalentumUseCase } from '../PublishVacancyToTalentumUseCase';

// ── Helpers ──────────────────────────────────────────────────────

const JP_ID = '22222222-2222-2222-2222-222222222222';

function rowsFor(overrides: Record<string, unknown> = {}) {
  return {
    id: JP_ID,
    title: 'Caso 42',
    talentum_project_id: null,
    talentum_description: 'descrição já existente',
    is_draft: true,
    ...overrides,
  };
}

describe('PublishVacancyToTalentumUseCase — o envio não move o paciente (D1)', () => {
  let useCase: PublishVacancyToTalentumUseCase;
  const QUESTION = { id: 'q1', question: 'q?', response_type: null, desired_response: null, weight: 1, required: true, analyzed: true, early_stoppage: false };
  const todasAsQueries = () => [...mockQuery.mock.calls, ...mockClientQuery.mock.calls].map((c) => String(c[0]));

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();

    mockConnect.mockResolvedValue({ query: mockClientQuery, release: mockClientRelease });
    mockClientQuery.mockResolvedValue({ rows: [] });

    mockTalentumCreate.mockResolvedValue({
      createPrescreening: mockCreatePrescreening,
      getPrescreening: mockGetPrescreening,
      deletePrescreening: mockDeletePrescreening,
    });
    mockCreatePrescreening.mockResolvedValue({ projectId: 'proj-1', publicId: 'pub-1' });
    mockGetPrescreening.mockResolvedValue({ whatsappUrl: 'https://wa.me/talentum/proj-1', slug: 'caso-42' });

    useCase = new PublishVacancyToTalentumUseCase();
  });

  it('feliz: BEGIN → UPDATE job_postings → COMMIT → release, e nenhuma query toca patients nem change_source', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [rowsFor()] }).mockResolvedValueOnce({ rows: [QUESTION] });

    const result = await useCase.publish({ jobPostingId: JP_ID });

    expect(result).toEqual({ projectId: 'proj-1', publicId: 'pub-1', whatsappUrl: 'https://wa.me/talentum/proj-1' });
    const clientCalls = mockClientQuery.mock.calls.map((c) => String(c[0]));
    const beginIdx = clientCalls.findIndex((sql) => sql === 'BEGIN');
    const updateIdx = clientCalls.findIndex((sql) => sql.includes('UPDATE job_postings'));
    const commitIdx = clientCalls.findIndex((sql) => sql === 'COMMIT');
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(updateIdx).toBeGreaterThan(beginIdx);
    expect(commitIdx).toBeGreaterThan(updateIdx);
    expect(mockClientRelease).toHaveBeenCalledTimes(1);

    const queries = todasAsQueries();
    expect(queries.length).toBeGreaterThan(3); // controle: a medição enxerga as queries do publish
    expect(queries.filter((sql) => /\bpatients\b/i.test(sql) || sql.includes('app.change_source'))).toEqual([]);
  });

  it('createPrescreening (Talentum) recusa → PublishError(502) e nenhuma transação aberta', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [rowsFor()] }).mockResolvedValueOnce({ rows: [QUESTION] });
    mockCreatePrescreening.mockRejectedValue(new Error('talentum-create-boom'));

    await expect(useCase.publish({ jobPostingId: JP_ID })).rejects.toMatchObject({ statusCode: 502 });

    expect(mockConnect).not.toHaveBeenCalled();
    expect(todasAsQueries().filter((sql) => /\bpatients\b/i.test(sql))).toEqual([]);
  });

  it('UPDATE da transação lança → ROLLBACK e relança', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [rowsFor()] }).mockResolvedValueOnce({ rows: [QUESTION] });
    mockClientQuery.mockImplementation((sql: string) => {
      if (sql === 'BEGIN') return Promise.resolve({ rows: [] });
      if (String(sql).includes('UPDATE job_postings')) return Promise.reject(new Error('update-boom'));
      return Promise.resolve({ rows: [] });
    });

    await expect(useCase.publish({ jobPostingId: JP_ID })).rejects.toThrow('update-boom');

    expect(mockClientQuery.mock.calls.map((c) => String(c[0]))).toContain('ROLLBACK');
  });

  it('unpublish: só apaga o projeto na Talentum, sem tocar patients', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ talentum_project_id: 'proj-1', is_draft: false }] });

    await useCase.unpublish({ jobPostingId: JP_ID });

    expect(mockDeletePrescreening).toHaveBeenCalledWith('proj-1');
    expect(todasAsQueries().filter((sql) => /\bpatients\b/i.test(sql))).toEqual([]);
  });
});
