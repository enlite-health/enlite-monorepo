/**
 * PreviewAiPromptUseCase — spec 029 T031a (FR-026): o preview NUNCA chama o Talentum.
 *
 * Fronteira espionada (a MESMA nos dois testes, via `talentumCalls()`):
 *  - `TalentumApiClient.prototype.createPrescreening/getPrescreening/deletePrescreening`
 *    (classe REAL, TalentumApiClient.ts) — é o método que o publish chama (PublishVacancyToTalentumUseCase.ts:145-160);
 *  - `global.fetch` — a saída HTTP de baixo nível do cliente (login, create, get); qualquer cliente novo passaria por aqui.
 * O espião nunca deixa a chamada seguir: fetch rejeita e os métodos são dublados. Nada toca rede.
 *
 * O caso positivo (teste 2) roda o caminho REAL de publicação pela mesma fronteira: sem ele,
 * "zero chamadas" não distingue "não chamou" de "espião montado no lugar errado".
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

const mockPoolQuery = jest.fn();
const mockPoolConnect = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: () => ({ getPool: () => ({ query: mockPoolQuery, connect: mockPoolConnect }) }),
  },
}));

jest.mock('@shared/logging', () => ({ reportError: jest.fn() }));

import type { Pool } from 'pg';
import { PreviewAiPromptUseCase } from '../PreviewAiPromptUseCase';
import { PublishVacancyToTalentumUseCase } from '../PublishVacancyToTalentumUseCase';
import { TalentumApiClient } from '../../infrastructure/TalentumApiClient';
import { TalentumDescriptionService } from '../../infrastructure/TalentumDescriptionService';
import { GeminiVacancyParserService } from '../../infrastructure/GeminiVacancyParserService';
import type { AiPromptSlug } from '../../domain/AiPromptSlug';

const JOB_ID = '22222222-2222-2222-2222-222222222222';
const CASE_ROW = {
  id: JOB_ID, title: 'Caso 7', case_number: 7, required_professions: ['AT'], required_sex: null,
  age_range_min: 20, age_range_max: 40, required_experience: null, worker_attributes: null,
  schedule: null, work_schedule: null, providers_needed: 1, salary_text: null, payment_day: null,
  daily_obs: null, address_formatted: null, city: 'CABA', state: 'BA',
  diagnosis: 'TEA', dependency_level: 'Leve', service_type: ['Domiciliario'],
};
const PRESCREENING_PAYLOAD = {
  vacancy: { case_number: 7, title: 'Caso 7', required_professions: ['AT'] },
  prescreening: { questions: [{ question: 'q', responseType: 'TEXT', desiredResponse: 'x', weight: 1, required: true, analyzed: true, earlyStoppage: false }], faq: [] },
};

let createSpy: jest.SpyInstance;
let getSpy: jest.SpyInstance;
let deleteSpy: jest.SpyInstance;
let fetchSpy: jest.SpyInstance;

/** Total de chamadas que chegaram à fronteira do Talentum (cliente real + fetch). */
function talentumCalls(): number {
  return createSpy.mock.calls.length + getSpy.mock.calls.length
    + deleteSpy.mock.calls.length + fetchSpy.mock.calls.length;
}

const ENV_KEYS = ['TALENTUM_API_EMAIL', 'TALENTUM_API_PASSWORD'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  createSpy = jest.spyOn(TalentumApiClient.prototype, 'createPrescreening')
    .mockResolvedValue({ projectId: 'proj-1', publicId: 'pub-1' } as never);
  getSpy = jest.spyOn(TalentumApiClient.prototype, 'getPrescreening')
    .mockResolvedValue({ whatsappUrl: 'https://wa.me/x', slug: 'caso' } as never);
  deleteSpy = jest.spyOn(TalentumApiClient.prototype, 'deletePrescreening').mockResolvedValue(undefined as never);
  fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('rede bloqueada no teste'));
  mockGenerateContentVertex.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({
      candidates: [{ content: { parts: [{ text: JSON.stringify(PRESCREENING_PAYLOAD) }] }, finishReason: 'STOP' }],
    }),
  });
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
  jest.restoreAllMocks();
});

describe('PreviewAiPromptUseCase — FR-026 sem Talentum', () => {
  it('zero chamadas ao Talentum nos tres slugs', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [CASE_ROW], rowCount: 1 });
    const descService = new TalentumDescriptionService();
    jest.spyOn(descService as never, 'loadInput' as never).mockResolvedValue(
      { caseNumber: '7', title: 'Caso 7', requiredProfessions: ['AT'] } as never,
    );
    const useCase = new PreviewAiPromptUseCase({
      db: { query, connect: jest.fn() } as unknown as Pool,
      descService,
      parserService: new GeminiVacancyParserService(),
    });
    mockGenerateContentVertex.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        candidates: [{ content: { parts: [{ text: JSON.stringify({ propuesta: 'p', perfilProfesional: 'q' }) }] }, finishReason: 'STOP' }],
      }),
    });

    const slugs: AiPromptSlug[] = ['VACANCY_DESCRIPTION', 'PRESCREENING_AT', 'PRESCREENING_CAREGIVER'];
    for (const slug of slugs) {
      const out = await useCase.execute({ slug, body: 'TEXTO EM EDICAO', jobPostingId: JOB_ID });
      expect(out.slug).toBe(slug);
    }

    // o modelo (Vertex dublado) foi de fato chamado: o caso de uso rodou de verdade
    expect(mockGenerateContentVertex.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(talentumCalls()).toBe(0);
  });

  it('o espiao acusa quando HA chamada (publish real pela mesma fronteira)', async () => {
    process.env.TALENTUM_API_EMAIL = 'qa@example.invalid';
    process.env.TALENTUM_API_PASSWORD = 'nao-e-credencial-real';
    const question = { id: 'q1', question: 'q?', response_type: null, desired_response: null, weight: 1, required: true, analyzed: true, early_stoppage: false };
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ id: JOB_ID, title: 'Caso 7', talentum_project_id: null, talentum_description: 'desc', is_draft: true }] })
      .mockResolvedValueOnce({ rows: [question] })
      .mockResolvedValueOnce({ rows: [] });
    mockPoolConnect.mockResolvedValue({ query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() });

    expect(talentumCalls()).toBe(0);
    await new PublishVacancyToTalentumUseCase(jest.fn().mockResolvedValue({})).publish({ jobPostingId: JOB_ID });

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(talentumCalls()).toBeGreaterThanOrEqual(1);
  });
});
