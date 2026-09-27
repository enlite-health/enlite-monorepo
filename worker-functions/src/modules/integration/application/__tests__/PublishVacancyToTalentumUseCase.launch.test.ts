/**
 * PublishVacancyToTalentumUseCase.launch.test.ts
 *
 * Cobertura do gancho pós-commit (DX-6.1/DX-6.2/DX-6.11 (i)): o envio à Talentum chama
 * `launchHook(jobPostingId)` DEPOIS do COMMIT e do release do client, `await`ado (não
 * fire-and-forget), antes do retorno. Recusa da Talentum (create/get) → o gancho NÃO roda.
 * Rejeição do gancho → o publish AINDA resolve com o resultado (2ª trava: `reportError`).
 * `unpublish` nunca chama o gancho.
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

const mockReportError = jest.fn();
jest.mock('@shared/logging', () => ({
  reportError: (...args: unknown[]) => mockReportError(...args),
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

describe('PublishVacancyToTalentumUseCase — gancho pós-commit (P8)', () => {
  let launchHook: jest.Mock;
  let useCase: PublishVacancyToTalentumUseCase;

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

    launchHook = jest.fn().mockResolvedValue({ jobPostingId: JP_ID, patient: 'moved', match: { candidates: 3 } });
    useCase = new PublishVacancyToTalentumUseCase(launchHook);
  });

  it('feliz: launchHook 1× com o id, DEPOIS de BEGIN → UPDATE → COMMIT → release', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [rowsFor()] }) // vacancy
      .mockResolvedValueOnce({ rows: [{ id: 'q1', question: 'q?', response_type: null, desired_response: null, weight: 1, required: true, analyzed: true, early_stoppage: false }] }) // questions
      .mockResolvedValueOnce({ rows: [] }); // faq

    const result = await useCase.publish({ jobPostingId: JP_ID });

    expect(result).toEqual({ projectId: 'proj-1', publicId: 'pub-1', whatsappUrl: 'https://wa.me/talentum/proj-1' });
    expect(launchHook).toHaveBeenCalledTimes(1);
    expect(launchHook).toHaveBeenCalledWith(JP_ID);

    // Ordem: BEGIN → UPDATE job_postings → COMMIT → release → launchHook
    const clientCalls = mockClientQuery.mock.calls.map(c => String(c[0]));
    const beginIdx = clientCalls.findIndex(sql => sql === 'BEGIN');
    const updateIdx = clientCalls.findIndex(sql => sql.includes('UPDATE job_postings'));
    const commitIdx = clientCalls.findIndex(sql => sql === 'COMMIT');
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(updateIdx).toBeGreaterThan(beginIdx);
    expect(commitIdx).toBeGreaterThan(updateIdx);

    const releaseOrder = mockClientRelease.mock.invocationCallOrder[0];
    const commitOrder = mockClientQuery.mock.invocationCallOrder[commitIdx];
    const launchHookOrder = launchHook.mock.invocationCallOrder[0];
    expect(releaseOrder).toBeGreaterThan(commitOrder);
    expect(launchHookOrder).toBeGreaterThan(releaseOrder);

    expect(mockReportError).not.toHaveBeenCalled();
  });

  it('createPrescreening (Talentum) recusa → PublishError(502) e launchHook 0×', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [rowsFor()] })
      .mockResolvedValueOnce({ rows: [{ id: 'q1', question: 'q?', response_type: null, desired_response: null, weight: 1, required: true, analyzed: true, early_stoppage: false }] })
      .mockResolvedValueOnce({ rows: [] });
    mockCreatePrescreening.mockRejectedValue(new Error('talentum-create-boom'));

    await expect(useCase.publish({ jobPostingId: JP_ID })).rejects.toMatchObject({ statusCode: 502 });

    expect(launchHook).not.toHaveBeenCalled();
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('getPrescreening (Talentum) recusa → PublishError(502) e launchHook 0×', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [rowsFor()] })
      .mockResolvedValueOnce({ rows: [{ id: 'q1', question: 'q?', response_type: null, desired_response: null, weight: 1, required: true, analyzed: true, early_stoppage: false }] })
      .mockResolvedValueOnce({ rows: [] });
    mockGetPrescreening.mockRejectedValue(new Error('talentum-get-boom'));

    await expect(useCase.publish({ jobPostingId: JP_ID })).rejects.toMatchObject({ statusCode: 502 });

    expect(launchHook).not.toHaveBeenCalled();
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('UPDATE da transação lança → ROLLBACK, relança, launchHook 0×', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [rowsFor()] })
      .mockResolvedValueOnce({ rows: [{ id: 'q1', question: 'q?', response_type: null, desired_response: null, weight: 1, required: true, analyzed: true, early_stoppage: false }] })
      .mockResolvedValueOnce({ rows: [] });
    mockClientQuery.mockImplementation((sql: string) => {
      if (sql === 'BEGIN') return Promise.resolve({ rows: [] });
      if (String(sql).includes('UPDATE job_postings')) return Promise.reject(new Error('update-boom'));
      return Promise.resolve({ rows: [] });
    });

    await expect(useCase.publish({ jobPostingId: JP_ID })).rejects.toThrow('update-boom');

    const clientCalls = mockClientQuery.mock.calls.map(c => String(c[0]));
    expect(clientCalls).toContain('ROLLBACK');
    expect(launchHook).not.toHaveBeenCalled();
  });

  it('launchHook rejeita: o publish AINDA resolve com o resultado, e reportError roda 1×', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [rowsFor()] })
      .mockResolvedValueOnce({ rows: [{ id: 'q1', question: 'q?', response_type: null, desired_response: null, weight: 1, required: true, analyzed: true, early_stoppage: false }] })
      .mockResolvedValueOnce({ rows: [] });
    launchHook.mockRejectedValue(new Error('hook-boom'));

    const result = await useCase.publish({ jobPostingId: JP_ID });

    expect(result).toEqual({ projectId: 'proj-1', publicId: 'pub-1', whatsappUrl: 'https://wa.me/talentum/proj-1' });
    expect(launchHook).toHaveBeenCalledTimes(1);
    expect(mockReportError).toHaveBeenCalledTimes(1);
    expect(mockReportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'hook-boom' }),
      expect.objectContaining({ source: 'PublishVacancyToTalentumUseCase:launchHook' }),
    );
  });

  it('unpublish: launchHook 0×', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ talentum_project_id: 'proj-1', is_draft: false }] });

    await useCase.unpublish({ jobPostingId: JP_ID });

    expect(launchHook).not.toHaveBeenCalled();
    expect(mockDeletePrescreening).toHaveBeenCalledWith('proj-1');
  });
});
