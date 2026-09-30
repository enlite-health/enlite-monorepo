/**
 * PreviewAiPromptUseCase — spec 029 T030.
 *
 * Usa os geradores REAIS (não dublês) para provar o que chega ao modelo. Só as fronteiras são
 * dubladas: `generateContentVertex` (nunca chama Vertex), `AiPromptRepository` (devolve SEMPRE um
 * texto diferente do parâmetro) e o pool (SELECT do caso; registra toda query para provar que
 * nenhuma escrita acontece).
 */
const mockGenerateContentVertex = jest.fn();
jest.mock('../../infrastructure/vertex-gemini', () => ({
  generateContentVertex: (...args: unknown[]) => mockGenerateContentVertex(...args),
}));

const mockFindActiveBySlug = jest.fn();
jest.mock('../../infrastructure/AiPromptRepository', () => ({
  AiPromptRepository: jest.fn().mockImplementation(() => ({
    findActiveBySlug: (...args: unknown[]) => mockFindActiveBySlug(...args),
  })),
}));

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({}) }) },
}));

import type { Pool } from 'pg';
import {
  PreviewAiPromptUseCase,
  PreviewEmptyBodyError,
  JobPostingNotFoundError,
} from '../PreviewAiPromptUseCase';
import { TalentumDescriptionService } from '../../infrastructure/TalentumDescriptionService';
import { GeminiVacancyParserService } from '../../infrastructure/GeminiVacancyParserService';

const JOB_ID = '22222222-2222-2222-2222-222222222222';
const TABLE_TEXT = 'TEXTO DA TABELA ai_prompts (nao deve chegar ao modelo)';
const EDITING_TEXT = 'TEXTO EM EDICAO, AINDA NAO SALVO';

const CASE_ROW = {
  id: JOB_ID, title: 'Caso 7', case_number: 7, required_professions: ['AT'], required_sex: null,
  age_range_min: 20, age_range_max: 40, required_experience: null, worker_attributes: null,
  schedule: null, work_schedule: null, providers_needed: 1, salary_text: null, payment_day: null,
  daily_obs: null, address_formatted: null, city: 'CABA', state: 'BA', neighborhood: 'Palermo',
  diagnosis: 'TEA', dependency_level: 'Leve', service_type: ['Domiciliario'], pathology_types: 'TEA',
  service_device_types: 'Domiciliario',
};

function makePool(rows: unknown[]) {
  const query = jest.fn().mockResolvedValue({ rows, rowCount: rows.length });
  const connect = jest.fn();
  return { pool: { query, connect } as unknown as Pool, query, connect };
}

function vertexResponse(payload: unknown) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] }, finishReason: 'STOP' }],
      }),
  };
}

const PRESCREENING_PAYLOAD = {
  vacancy: { case_number: 7, title: 'Caso 7', required_professions: ['AT'] },
  prescreening: { questions: [{ question: 'q', responseType: 'TEXT', desiredResponse: 'x', weight: 1, required: true, analyzed: true, earlyStoppage: false }], faq: [] },
};

function makeUseCase(rows: unknown[] = [CASE_ROW]) {
  const { pool, query, connect } = makePool(rows);
  const useCase = new PreviewAiPromptUseCase({
    db: pool,
    descService: new TalentumDescriptionService(),
    parserService: new GeminiVacancyParserService(),
  });
  return { useCase, query, connect };
}

/** O que chegou ao modelo como systemInstruction na 1a chamada. */
function systemTextSentToModel(): string {
  const request = mockGenerateContentVertex.mock.calls[0][1];
  return request.systemInstruction.parts[0].text;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFindActiveBySlug.mockResolvedValue({ slug: 'X', body: TABLE_TEXT, version: 1, isActive: true });
});

describe('PreviewAiPromptUseCase', () => {
  it('VACANCY_DESCRIPTION: o modelo recebe o texto do PARAMETRO, nao o da tabela', async () => {
    // composeDescription faz SELECT do caso; o pool dublê devolve a mesma linha para o SELECT.
    mockGenerateContentVertex.mockResolvedValue(
      vertexResponse({ propuesta: 'propuesta ok', perfilProfesional: 'perfil ok' }),
    );
    const { useCase } = makeUseCase();

    // TalentumDescriptionService usa o pool do singleton (dublê `{}`); injetamos o pool via spy no loadInput.
    const svc = (useCase as any).descService as TalentumDescriptionService;
    jest.spyOn(svc as any, 'loadInput').mockResolvedValue({
      caseNumber: '7', title: 'Caso 7', requiredProfessions: ['AT'],
    });

    const out = await useCase.execute({ slug: 'VACANCY_DESCRIPTION', body: EDITING_TEXT, jobPostingId: JOB_ID });

    expect(systemTextSentToModel()).toBe(EDITING_TEXT);
    expect(systemTextSentToModel()).not.toContain(TABLE_TEXT);
    expect(mockFindActiveBySlug).not.toHaveBeenCalled();
    expect(out.slug).toBe('VACANCY_DESCRIPTION');
    expect(out.jobPostingId).toBe(JOB_ID);
    expect(out.generated).toContain('propuesta ok');
  });

  it('PRESCREENING_AT: usa o texto do parametro e workerType AT (derivado do slug)', async () => {
    mockGenerateContentVertex.mockResolvedValue(vertexResponse(PRESCREENING_PAYLOAD));
    const { useCase } = makeUseCase();
    const parser = (useCase as any).parserService as GeminiVacancyParserService;
    const spy = jest.spyOn(parser, 'generateFromVacancyData');

    const out = await useCase.execute({ slug: 'PRESCREENING_AT', body: EDITING_TEXT, jobPostingId: JOB_ID });

    expect(spy.mock.calls[0][3]).toBe('AT');
    expect(spy.mock.calls[0][4]).toBe(EDITING_TEXT);
    expect(systemTextSentToModel()).toContain(EDITING_TEXT);
    expect(systemTextSentToModel()).not.toContain(TABLE_TEXT);
    expect(mockFindActiveBySlug).not.toHaveBeenCalled();
    expect(out.slug).toBe('PRESCREENING_AT');
    expect(JSON.parse(out.generated).questions).toHaveLength(1);
  });

  it('PRESCREENING_CAREGIVER: usa o texto do parametro e workerType CUIDADOR (derivado do slug)', async () => {
    mockGenerateContentVertex.mockResolvedValue(vertexResponse(PRESCREENING_PAYLOAD));
    const { useCase } = makeUseCase();
    const parser = (useCase as any).parserService as GeminiVacancyParserService;
    const spy = jest.spyOn(parser, 'generateFromVacancyData');

    await useCase.execute({ slug: 'PRESCREENING_CAREGIVER', body: EDITING_TEXT, jobPostingId: JOB_ID });

    expect(spy.mock.calls[0][3]).toBe('CUIDADOR');
    expect(systemTextSentToModel()).toContain(EDITING_TEXT);
    expect(systemTextSentToModel()).not.toContain(TABLE_TEXT);
    expect(mockFindActiveBySlug).not.toHaveBeenCalled();
  });

  it('prescreening e somente-leitura: so SELECT, nenhuma escrita, sem transacao', async () => {
    mockGenerateContentVertex.mockResolvedValue(vertexResponse(PRESCREENING_PAYLOAD));
    const { useCase, query, connect } = makeUseCase();

    await useCase.execute({ slug: 'PRESCREENING_AT', body: EDITING_TEXT, jobPostingId: JOB_ID });

    const sqls = query.mock.calls.map((c) => String(c[0]));
    expect(sqls.length).toBeGreaterThan(0);
    for (const sql of sqls) expect(sql.trim().toUpperCase().startsWith('SELECT')).toBe(true);
    expect(connect).not.toHaveBeenCalled();
  });

  it('jobPostingId inexistente (prescreening) -> JobPostingNotFoundError, sem chamar o modelo', async () => {
    const { useCase } = makeUseCase([]);
    await expect(
      useCase.execute({ slug: 'PRESCREENING_AT', body: EDITING_TEXT, jobPostingId: JOB_ID }),
    ).rejects.toBeInstanceOf(JobPostingNotFoundError);
    expect(mockGenerateContentVertex).not.toHaveBeenCalled();
  });

  it('jobPostingId inexistente (VACANCY_DESCRIPTION) -> JobPostingNotFoundError', async () => {
    const { useCase } = makeUseCase();
    const svc = (useCase as any).descService as TalentumDescriptionService;
    jest.spyOn(svc as any, 'loadInput').mockRejectedValue(new JobPostingNotFoundError(JOB_ID));
    await expect(
      useCase.execute({ slug: 'VACANCY_DESCRIPTION', body: EDITING_TEXT, jobPostingId: JOB_ID }),
    ).rejects.toBeInstanceOf(JobPostingNotFoundError);
    expect(mockGenerateContentVertex).not.toHaveBeenCalled();
  });

  it.each(['', '   ', '\n\t '])('body vazio/so espacos (%j) -> PreviewEmptyBodyError', async (body) => {
    const { useCase } = makeUseCase();
    await expect(
      useCase.execute({ slug: 'PRESCREENING_AT', body, jobPostingId: JOB_ID }),
    ).rejects.toBeInstanceOf(PreviewEmptyBodyError);
    expect(mockGenerateContentVertex).not.toHaveBeenCalled();
  });
});
