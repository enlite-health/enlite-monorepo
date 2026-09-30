/**
 * PreviewAiPromptUseCase — spec 029 T070: o preview roda o MESMO modelo da produção.
 *
 * Produção (VacancyTalentumController): `process.env.GEMINI_MODEL_FAST ?? 'gemini-2.5-flash'`
 * entregue aos DOIS serviços. Sem override os serviços caem em GEMINI_MODEL ?? 'gemini-2.5-pro'.
 *
 * Fronteira espionada: o 1º argumento de `generateContentVertex` (o modelo que de fato chega ao Vertex).
 * Controle positivo: com GEMINI_MODEL_FAST = valor inventado, o teste TEM de enxergá-lo; sem isso
 * "não é pro" passaria mesmo com o instrumento cego.
 */
const mockGenerateContentVertex = jest.fn();
jest.mock('../../infrastructure/vertex-gemini', () => ({
  generateContentVertex: (...args: unknown[]) => mockGenerateContentVertex(...args),
}));

jest.mock('../../infrastructure/AiPromptRepository', () => ({
  AiPromptRepository: jest.fn().mockImplementation(() => ({
    findActiveBySlug: jest.fn().mockResolvedValue({ slug: 'X', body: 'TABELA', version: 1, isActive: true }),
  })),
}));

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({}) }) },
}));

import type { Pool } from 'pg';
import { PreviewAiPromptUseCase } from '../PreviewAiPromptUseCase';
import { TalentumDescriptionService } from '../../infrastructure/TalentumDescriptionService';

const JOB_ID = '22222222-2222-2222-2222-222222222222';
const SENTINELA = 'gemini-test-sentinela';
const CASE_ROW = {
  id: JOB_ID, title: 'Caso 7', case_number: 7, required_professions: ['AT'], required_sex: null,
  age_range_min: 20, age_range_max: 40, required_experience: null, worker_attributes: null,
  schedule: null, work_schedule: null, providers_needed: 1, salary_text: null, payment_day: null,
  daily_obs: null, address_formatted: null, city: 'CABA', state: 'BA',
  diagnosis: 'TEA', dependency_level: 'Leve', service_type: ['Domiciliario'],
};

function vertexResponse(payload: unknown) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] }, finishReason: 'STOP' }],
      }),
  };
}

/** Sem descService/parserService: exercita o FALLBACK do use case (o que o conserto muda). */
function makeUseCase() {
  const query = jest.fn().mockResolvedValue({ rows: [CASE_ROW], rowCount: 1 });
  const pool = { query, connect: jest.fn() } as unknown as Pool;
  const useCase = new PreviewAiPromptUseCase({ db: pool });
  const svc = (useCase as any).descService as TalentumDescriptionService;
  jest.spyOn(svc as any, 'loadInput').mockResolvedValue({
    caseNumber: '7', title: 'Caso 7', requiredProfessions: ['AT'],
  });
  return useCase;
}

async function modelSentForSlug(slug: 'VACANCY_DESCRIPTION' | 'PRESCREENING_AT'): Promise<string> {
  mockGenerateContentVertex.mockResolvedValue(
    slug === 'VACANCY_DESCRIPTION'
      ? vertexResponse({ propuesta: 'p', perfilProfesional: 'pp' })
      : vertexResponse({
          vacancy: { case_number: 7, title: 'Caso 7', required_professions: ['AT'] },
          prescreening: { questions: [], faq: [] },
        }),
  );
  await makeUseCase().execute({ slug, body: 'TEXTO EM EDICAO', jobPostingId: JOB_ID });
  expect(mockGenerateContentVertex).toHaveBeenCalled();
  return mockGenerateContentVertex.mock.calls[0][0] as string;
}

const SAVED = { fast: process.env.GEMINI_MODEL_FAST, base: process.env.GEMINI_MODEL };
function restore(name: 'GEMINI_MODEL_FAST' | 'GEMINI_MODEL', value: string | undefined) {
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
}

beforeEach(() => {
  jest.clearAllMocks();
});
afterAll(() => {
  restore('GEMINI_MODEL_FAST', SAVED.fast);
  restore('GEMINI_MODEL', SAVED.base);
});

describe('PreviewAiPromptUseCase — modelo = o da produção (GEMINI_MODEL_FAST)', () => {
  it.each(['VACANCY_DESCRIPTION', 'PRESCREENING_AT'] as const)(
    'CONTROLE POSITIVO %s: com GEMINI_MODEL_FAST inventado, o modelo entregue é exatamente esse valor',
    async (slug) => {
      process.env.GEMINI_MODEL_FAST = SENTINELA;
      process.env.GEMINI_MODEL = 'gemini-2.5-pro';
      expect(await modelSentForSlug(slug)).toBe(SENTINELA);
    },
  );

  it.each(['VACANCY_DESCRIPTION', 'PRESCREENING_AT'] as const)(
    'NEGATIVA %s: sem GEMINI_MODEL_FAST o modelo é o flash da produção, nunca o default pro',
    async (slug) => {
      delete process.env.GEMINI_MODEL_FAST;
      process.env.GEMINI_MODEL = 'gemini-2.5-pro';
      const model = await modelSentForSlug(slug);
      expect(model).toBe('gemini-2.5-flash');
      expect(model).not.toBe('gemini-2.5-pro');
    },
  );
});
