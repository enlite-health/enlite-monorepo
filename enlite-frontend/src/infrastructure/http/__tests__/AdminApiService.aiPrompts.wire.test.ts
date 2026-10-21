import { describe, it, expect, vi, afterEach } from 'vitest';

// Spec 029 — A JUNTA entre backend e frontend.
//
// O outro teste (`AdminApiService.aiPrompts.test.ts`) dubla `request()`, justamente a peça que
// lê `json.success`. Foi assim que o backend passou a devolver `{ data }` sem `success` e a tela
// `/admin/prompts-ia` ficou inutilizável com CI verde. Aqui `request()` é REAL; só `fetch` e o
// token são dublados, e o corpo é o LITERAL que `AiPromptController` produz nos 200
// (`{ success: true, data }`). O par no backend é
// `AiPromptController.test.ts` (`toEqual({ success: true, data: ... })`): se um dos lados mudar
// a forma, o seu teste quebra.

vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({
    getIdToken: vi.fn().mockResolvedValue('token-de-teste'),
  })),
}));

import { AdminApiService } from '../AdminApiService';

const PROMPT_NO_FORMATO_DO_BACKEND = {
  slug: 'VACANCY_DESCRIPTION',
  body: 'texto do prompt',
  version: 1,
  updatedBy: 'migration-487-seed',
  updatedAt: '2026-09-29T12:00:00.000Z',
  isActive: true,
};

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({ status, json: () => Promise.resolve(body) });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('AdminApiService x AiPromptController — corpo real de 200 (sem dublar request)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('listAiPrompts devolve os dados em vez de lançar', async () => {
    stubFetch(200, { success: true, data: [PROMPT_NO_FORMATO_DO_BACKEND] });
    await expect(AdminApiService.listAiPrompts()).resolves.toEqual([PROMPT_NO_FORMATO_DO_BACKEND]);
  });

  it('getAiPrompt devolve o registro', async () => {
    stubFetch(200, { success: true, data: PROMPT_NO_FORMATO_DO_BACKEND });
    await expect(AdminApiService.getAiPrompt('VACANCY_DESCRIPTION')).resolves.toEqual(PROMPT_NO_FORMATO_DO_BACKEND);
  });

  it('updateAiPrompt devolve o registro', async () => {
    stubFetch(200, { success: true, data: { ...PROMPT_NO_FORMATO_DO_BACKEND, version: 2 } });
    await expect(AdminApiService.updateAiPrompt('VACANCY_DESCRIPTION', 'novo', 1)).resolves.toMatchObject({ version: 2 });
  });

  it('undoAiPrompt devolve o registro', async () => {
    stubFetch(200, { success: true, data: PROMPT_NO_FORMATO_DO_BACKEND });
    await expect(AdminApiService.undoAiPrompt('VACANCY_DESCRIPTION', 2)).resolves.toEqual(PROMPT_NO_FORMATO_DO_BACKEND);
  });

  it('o corpo SEM `success` (o defeito medido na stage) lança — a regressão é detectável', async () => {
    stubFetch(200, { data: [PROMPT_NO_FORMATO_DO_BACKEND] });
    await expect(AdminApiService.listAiPrompts()).rejects.toBeDefined();
  });

  it('previewAiPrompt resolve para o `data` do 200 { success: true, data }', async () => {
    const data = {
      jobPostingId: '11111111-1111-4111-8111-111111111111',
      slug: 'PRESCREENING_AT',
      generated: '{"questions":[{"q":"..."}],"faq":[]}',
    };
    const fetchMock = stubFetch(200, { success: true, data });
    await expect(
      AdminApiService.previewAiPrompt('PRESCREENING_AT', 'texto em edição', data.jobPostingId),
    ).resolves.toEqual(data);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/admin/ai-prompts/PRESCREENING_AT/preview');
    expect(JSON.parse(init.body)).toEqual({ body: 'texto em edição', jobPostingId: data.jobPostingId });
  });

  it('previewAiPrompt rejeita no 503 { success: false } — a tela preserva o texto em edição', async () => {
    stubFetch(503, { success: false, error: 'model_unavailable' });
    await expect(
      AdminApiService.previewAiPrompt('VACANCY_DESCRIPTION', 'texto', '11111111-1111-4111-8111-111111111111'),
    ).rejects.toMatchObject({ status: 503 });
  });
});

describe('AdminApiService x AiPromptController.simulateVacancy — corpo real de 200 (sem dublar request)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const CASE = '11111111-1111-4111-8111-111111111111';
  // Literal que `SimulateVacancyAiUseCase` + `AiPromptController.simulateVacancy` produzem no 200.
  const SIMULACAO_NO_FORMATO_DO_BACKEND = {
    description: 'Descrição gerada',
    prescreening: {
      questions: [
        { question: 'Q1', responseType: ['text', 'audio'], desiredResponse: 'R', weight: 5, required: true, analyzed: true, earlyStoppage: false },
      ],
      faq: [{ question: 'P', answer: 'R' }],
    },
    workerType: 'AT',
    usedSlugs: ['VACANCY_DESCRIPTION', 'PRESCREENING_AT'],
  };

  it('simulateVacancyCreation resolve para o `data` do 200 { success: true, data } e envia jobPostingId + bodies', async () => {
    const fetchMock = stubFetch(200, { success: true, data: SIMULACAO_NO_FORMATO_DO_BACKEND });
    await expect(
      AdminApiService.simulateVacancyCreation(CASE, { PRESCREENING_AT: 'texto em edição' }),
    ).resolves.toEqual(SIMULACAO_NO_FORMATO_DO_BACKEND);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/admin/ai-prompts/simulate-vacancy');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ jobPostingId: CASE, bodies: { PRESCREENING_AT: 'texto em edição' } });
  });

  it('o corpo SEM `success` (o defeito medido na stage) lança — a regressão é detectável', async () => {
    stubFetch(200, { data: SIMULACAO_NO_FORMATO_DO_BACKEND });
    await expect(AdminApiService.simulateVacancyCreation(CASE, {})).rejects.toBeDefined();
  });

  it('503 e 404 rejeitam com o status (a tela distingue os dois)', async () => {
    stubFetch(503, { success: false, error: 'modelo_indisponivel' });
    await expect(AdminApiService.simulateVacancyCreation(CASE, {})).rejects.toMatchObject({ status: 503 });
    stubFetch(404, { success: false, error: 'caso_nao_encontrado' });
    await expect(AdminApiService.simulateVacancyCreation(CASE, {})).rejects.toMatchObject({ status: 404 });
  });
});
