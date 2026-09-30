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
});
