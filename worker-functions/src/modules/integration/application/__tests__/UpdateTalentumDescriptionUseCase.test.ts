/**
 * UpdateTalentumDescriptionUseCase.test.ts
 *
 * Cobertura da edição manual de descrição da vaga + propagação in-place ao Talentum.
 *
 * Cenários:
 *  1. Vaga NÃO publicada (talentum_project_id null) → só grava local, propagated=false
 *  2. Vaga publicada → getPrescreening + updatePrescreening (preserva questions/questionId), propagated=true
 *  3. Descrição vazia → 400
 *  4. Vaga inexistente → 404
 *  5. Falha do PUT no Talentum → 502 e NÃO persiste local (propaga antes de gravar)
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

const mockGetPrescreening = jest.fn();
const mockUpdatePrescreening = jest.fn();
const mockCreate = jest.fn();
jest.mock('../../infrastructure/TalentumApiClient', () => ({
  TalentumApiClient: {
    create: (...args: unknown[]) => mockCreate(...args),
  },
}));

// ── Imports ──────────────────────────────────────────────────────

import { UpdateTalentumDescriptionUseCase, UpdateDescriptionError } from '../UpdateTalentumDescriptionUseCase';
import { JobPostingAuditRepository } from '../../../matching/infrastructure/JobPostingAuditRepository';
import type { TalentumProject } from '../../domain/ITalentumApiClient';

// ── Helpers ──────────────────────────────────────────────────────

function makeProject(overrides: Partial<TalentumProject> = {}): TalentumProject {
  return {
    projectId: 'proj-1',
    publicId: 'pub-1',
    title: 'CASO 42 - AT Recoleta',
    description: 'Descripción vieja...',
    whatsappUrl: 'https://www.v2.talentum.chat/public/pre-screening/pub-1/chat',
    slug: 'caso-42',
    active: true,
    timestamp: '2025-01-15T10:00:00Z',
    questions: [
      { questionId: 'q1', question: '¿Tiene experiencia?', type: 'text', responseType: ['text'], desiredResponse: 'Sí', weight: 5, required: false, analyzed: true, earlyStoppage: false },
    ],
    faq: [{ question: '¿Horario?', answer: 'L-V 9 a 17' }],
    ...overrides,
  };
}

const ACTOR = { actorUserId: 'u1', actorType: 'HUMAN' as const, actorLabel: 'admin_panel', traceId: 't1' };
const JP_ID = '11111111-1111-1111-1111-111111111111';

// ── Tests ────────────────────────────────────────────────────────

describe('UpdateTalentumDescriptionUseCase', () => {
  let useCase: UpdateTalentumDescriptionUseCase;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
    mockClientQuery.mockResolvedValue({ rows: [] });
    mockConnect.mockResolvedValue({ query: mockClientQuery, release: mockClientRelease });
    mockCreate.mockResolvedValue({
      getPrescreening: mockGetPrescreening,
      updatePrescreening: mockUpdatePrescreening,
    });
    useCase = new UpdateTalentumDescriptionUseCase();
  });

  it('vaga não publicada: grava local sem tocar no Talentum (propagated=false)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: JP_ID, title: 'Caso 42', talentum_project_id: null, talentum_description: 'antiga' }],
    });

    const result = await useCase.execute({ jobPostingId: JP_ID, description: '  Nova descrição  ' }, ACTOR);

    expect(result).toEqual({ description: 'Nova descrição', propagated: false });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockGetPrescreening).not.toHaveBeenCalled();
    // UPDATE local com a descrição trimada
    const updateCall = mockClientQuery.mock.calls.find(c => String(c[0]).includes('UPDATE job_postings SET talentum_description'));
    expect(updateCall).toBeDefined();
    expect(updateCall![1]).toEqual(['Nova descrição', JP_ID]);
  });

  it('vaga publicada: propaga in-place preservando as perguntas do projeto', async () => {
    const project = makeProject();
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: JP_ID, title: 'Caso 42', talentum_project_id: 'proj-1', talentum_description: 'antiga' }],
    });
    mockGetPrescreening.mockResolvedValue(project);
    mockUpdatePrescreening.mockResolvedValue(undefined);

    const result = await useCase.execute({ jobPostingId: JP_ID, description: 'Descrição editada' }, ACTOR);

    expect(result).toEqual({ description: 'Descrição editada', propagated: true });
    expect(mockGetPrescreening).toHaveBeenCalledWith('proj-1');
    expect(mockUpdatePrescreening).toHaveBeenCalledWith('proj-1', {
      title: project.title,
      description: 'Descrição editada',
      questions: project.questions,
      faq: project.faq,
    });
  });

  it('descrição vazia → 400', async () => {
    await expect(useCase.execute({ jobPostingId: JP_ID, description: '   ' }, ACTOR)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('vaga inexistente → 404', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const err = await useCase.execute({ jobPostingId: JP_ID, description: 'x' }, ACTOR).catch(e => e);
    expect(err).toBeInstanceOf(UpdateDescriptionError);
    expect(err.statusCode).toBe(404);
  });

  it('projeto de outra conta (PUT 403) → 409 com mensagem acionável, sem persistir', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: JP_ID, title: 'Caso 42', talentum_project_id: 'proj-alheio', talentum_description: 'antiga' }],
    });
    mockGetPrescreening.mockResolvedValue(makeProject());
    mockUpdatePrescreening.mockRejectedValue(
      new Error('[TalentumApiClient] PATCH /projects/proj-alheio — HTTP 403: {"message":"You are not allowed to access this project"}'),
    );

    const err = await useCase.execute({ jobPostingId: JP_ID, description: 'Editada' }, ACTOR).catch(e => e);
    expect(err).toBeInstanceOf(UpdateDescriptionError);
    expect(err.statusCode).toBe(409);
    expect(err.message).toContain('otra cuenta');
    const updateCall = mockClientQuery.mock.calls.find(c => String(c[0]).includes('UPDATE job_postings SET talentum_description'));
    expect(updateCall).toBeUndefined();
  });

  it('projectId morto (GET 404 na v2) → 409 claro "rode a reconciliação", sem persistir', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: JP_ID, title: 'Caso 42', talentum_project_id: 'proj-morto', talentum_description: 'antiga' }],
    });
    mockGetPrescreening.mockRejectedValue(
      new Error('[TalentumApiClient] GET /projects/proj-morto — HTTP 404: {} (projeto não existe na Talentum v2; rode a reconciliação)'),
    );

    const err = await useCase.execute({ jobPostingId: JP_ID, description: 'Editada' }, ACTOR).catch(e => e);

    expect(err).toBeInstanceOf(UpdateDescriptionError);
    expect(err.statusCode).toBe(409);
    expect(err.message).toContain('rode a reconciliação');
    expect(mockUpdatePrescreening).not.toHaveBeenCalled();
    expect(mockClientQuery.mock.calls.find(c => String(c[0]).includes('UPDATE job_postings SET talentum_description'))).toBeUndefined();
  });

  it('GET falha com erro que não é 404 → 502 (continua transitório)', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: JP_ID, title: 'Caso 42', talentum_project_id: 'proj-1', talentum_description: 'antiga' }],
    });
    mockGetPrescreening.mockRejectedValue(new Error('[TalentumApiClient] GET /projects/proj-1 — HTTP 500: x'));

    await expect(useCase.execute({ jobPostingId: JP_ID, description: 'E' }, ACTOR)).rejects.toMatchObject({ statusCode: 502 });
  });

  it('projectId morto no PATCH (404 entre o GET e a escrita) → 409 claro, sem persistir', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: JP_ID, title: 'Caso 42', talentum_project_id: 'proj-morto', talentum_description: 'antiga' }],
    });
    mockGetPrescreening.mockResolvedValue(makeProject());
    mockUpdatePrescreening.mockRejectedValue(new Error('[TalentumApiClient] PATCH /projects/proj-morto/prescreening — HTTP 404: {}'));

    const err = await useCase.execute({ jobPostingId: JP_ID, description: 'Editada' }, ACTOR).catch(e => e);

    expect(err.statusCode).toBe(409);
    expect(err.message).toContain('rode a reconciliação');
    expect(mockClientQuery.mock.calls.find(c => String(c[0]).includes('UPDATE job_postings SET talentum_description'))).toBeUndefined();
  });

  it('falha do PUT no Talentum → 502 e NÃO persiste local', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: JP_ID, title: 'Caso 42', talentum_project_id: 'proj-1', talentum_description: 'antiga' }],
    });
    mockGetPrescreening.mockResolvedValue(makeProject());
    mockUpdatePrescreening.mockRejectedValue(new Error('boom'));

    await expect(useCase.execute({ jobPostingId: JP_ID, description: 'Editada' }, ACTOR)).rejects.toMatchObject({
      statusCode: 502,
    });
    // Nenhum UPDATE local rodou (propaga antes de gravar)
    const updateCall = mockClientQuery.mock.calls.find(c => String(c[0]).includes('UPDATE job_postings SET talentum_description'));
    expect(updateCall).toBeUndefined();
  });

  it('descrição ausente (undefined) → 400, sem tocar no banco', async () => {
    await expect(
      useCase.execute({ jobPostingId: JP_ID, description: undefined as unknown as string }, ACTOR),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('cliente da Talentum não inicializa (credenciais) → 502 e não persiste', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: JP_ID, title: 'Caso 42', talentum_project_id: 'proj-1', talentum_description: 'antiga' }],
    });
    mockCreate.mockRejectedValue(new Error('secrets vazios'));

    const err = await useCase.execute({ jobPostingId: JP_ID, description: 'Editada' }, ACTOR).catch(e => e);

    expect(err.statusCode).toBe(502);
    expect(err.message).toContain('Failed to initialize Talentum client');
    expect(mockClientQuery).not.toHaveBeenCalled();
  });

  it('com actor grava a auditoria UPDATED (traceId do actor, ou null quando ausente)', async () => {
    const audit = jest.spyOn(JobPostingAuditRepository.prototype, 'logEventSafe').mockResolvedValue(undefined);
    mockQuery.mockResolvedValue({
      rows: [{ id: JP_ID, title: 'Caso 42', talentum_project_id: null, talentum_description: 'antiga' }],
    });

    await useCase.execute({ jobPostingId: JP_ID, description: 'Nova' }, ACTOR);
    await useCase.execute({ jobPostingId: JP_ID, description: 'Nova 2' }, { ...ACTOR, traceId: undefined });

    expect(audit).toHaveBeenCalledTimes(2);
    expect(audit.mock.calls[0][1]).toMatchObject({ eventType: 'UPDATED', changes: { before: 'antiga', after: 'Nova' }, traceId: 't1' });
    expect(audit.mock.calls[1][1]).toMatchObject({ traceId: null });
    audit.mockRestore();
  });

  it('falha ao persistir local DEPOIS de propagar: ROLLBACK, log de DIVERGÊNCIA e relança', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: JP_ID, title: 'Caso 42', talentum_project_id: 'proj-1', talentum_description: 'antiga' }],
    });
    mockGetPrescreening.mockResolvedValue(makeProject());
    mockUpdatePrescreening.mockResolvedValue(undefined);
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('UPDATE job_postings SET talentum_description')) throw new Error('db caiu');
      return { rows: [] };
    });

    await expect(useCase.execute({ jobPostingId: JP_ID, description: 'Editada' }, ACTOR)).rejects.toThrow('db caiu');

    expect(mockClientQuery.mock.calls.map(c => c[0])).toContain('ROLLBACK');
    expect((console.error as jest.Mock).mock.calls.some(c => String(c[0]).includes('DIVERGENCE'))).toBe(true);
  });

  it('falha ao persistir local SEM propagação (vaga não publicada): ROLLBACK e relança, sem log de divergência', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: JP_ID, title: 'Caso 42', talentum_project_id: null, talentum_description: 'antiga' }],
    });
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('UPDATE job_postings SET talentum_description')) throw new Error('db caiu');
      return { rows: [] };
    });

    await expect(useCase.execute({ jobPostingId: JP_ID, description: 'Editada' }, ACTOR)).rejects.toThrow('db caiu');

    expect((console.error as jest.Mock).mock.calls.some(c => String(c[0]).includes('DIVERGENCE'))).toBe(false);
  });
});
