import { describe, it, expect, vi, afterEach } from 'vitest';
import { AdminApiService, type AiPrompt, type AiPromptSlug } from '../AdminApiService';

// Spec 029 (T022) — os quatro métodos de `AdminApiService` para `/api/admin/ai-prompts`.
// Contrato: `specs/029-prompts-ia-editaveis/contracts/admin-ai-prompts.md`.
//
// ⚠️ Cada teste afirma o VERBO e o CAMINHO literais passados a `request` — não só "chamou o
// cliente HTTP". Um `toHaveBeenCalledWith` genérico não pegaria um `/api/admin/ai-prompt/{slug}`
// (singular) ou um `PATCH` no lugar do `PUT` do contrato, e é exatamente esse tipo de erro que
// aparece em produção sem estourar em tempo de compilação (a URL é uma string).

const AI_PROMPT_SLUGS: readonly AiPromptSlug[] = ['VACANCY_DESCRIPTION', 'PRESCREENING_AT', 'PRESCREENING_CAREGIVER'];

function fakePrompt(slug: AiPromptSlug, overrides: Partial<AiPrompt> = {}): AiPrompt {
  return {
    slug,
    body: 'texto do prompt',
    version: 7,
    updatedBy: 'uid-abc',
    updatedAt: '2026-09-29T12:00:00Z',
    isActive: true,
    ...overrides,
  };
}

describe('AdminApiService - AI Prompts Methods (spec 029)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('listAiPrompts', () => {
    it('GET /api/admin/ai-prompts — sem parâmetro, sem corpo', async () => {
      const mockResponse = [fakePrompt('VACANCY_DESCRIPTION')];
      const requestSpy = vi
        .spyOn(AdminApiService, 'request' as keyof typeof AdminApiService)
        .mockResolvedValue(mockResponse);

      const result = await AdminApiService.listAiPrompts();

      expect(requestSpy).toHaveBeenCalledWith('GET', '/api/admin/ai-prompts');
      expect(requestSpy).toHaveBeenCalledTimes(1);
      expect(result).toEqual(mockResponse);
    });
  });

  describe('getAiPrompt', () => {
    it.each(AI_PROMPT_SLUGS)('GET /api/admin/ai-prompts/%s — caminho com o slug literal', async (slug) => {
      const mockResponse = fakePrompt(slug);
      const requestSpy = vi
        .spyOn(AdminApiService, 'request' as keyof typeof AdminApiService)
        .mockResolvedValue(mockResponse);

      const result = await AdminApiService.getAiPrompt(slug);

      expect(requestSpy).toHaveBeenCalledWith('GET', `/api/admin/ai-prompts/${slug}`);
      expect(result).toEqual(mockResponse);
    });
  });

  describe('updateAiPrompt', () => {
    it.each(AI_PROMPT_SLUGS)(
      'PUT /api/admin/ai-prompts/%s — corpo com { body, version }, sem outra chave',
      async (slug) => {
        const mockResponse = fakePrompt(slug, { version: 8 });
        const requestSpy = vi
          .spyOn(AdminApiService, 'request' as keyof typeof AdminApiService)
          .mockResolvedValue(mockResponse);

        const result = await AdminApiService.updateAiPrompt(slug, 'texto novo', 7);

        expect(requestSpy).toHaveBeenCalledWith('PUT', `/api/admin/ai-prompts/${slug}`, {
          body: 'texto novo',
          version: 7,
        });
        expect(result).toEqual(mockResponse);
      },
    );

    it('a versão enviada é a que o cliente leu (expectedVersion), não a devolvida pelo servidor', async () => {
      const requestSpy = vi
        .spyOn(AdminApiService, 'request' as keyof typeof AdminApiService)
        .mockResolvedValue(fakePrompt('VACANCY_DESCRIPTION', { version: 8 }));

      await AdminApiService.updateAiPrompt('VACANCY_DESCRIPTION', 'texto novo', 7);

      expect(requestSpy).toHaveBeenCalledWith(
        'PUT',
        '/api/admin/ai-prompts/VACANCY_DESCRIPTION',
        expect.objectContaining({ version: 7 }),
      );
    });
  });

  describe('undoAiPrompt', () => {
    it.each(AI_PROMPT_SLUGS)(
      'POST /api/admin/ai-prompts/%s/undo — corpo com { version }, sem alvo/auditId',
      async (slug) => {
        const mockResponse = fakePrompt(slug, { version: 6 });
        const requestSpy = vi
          .spyOn(AdminApiService, 'request' as keyof typeof AdminApiService)
          .mockResolvedValue(mockResponse);

        const result = await AdminApiService.undoAiPrompt(slug, 7);

        expect(requestSpy).toHaveBeenCalledWith('POST', `/api/admin/ai-prompts/${slug}/undo`, { version: 7 });
        expect(result).toEqual(mockResponse);
      },
    );

    it('não é confundido com a rota de update (verbo POST, sufixo /undo, nunca PUT)', async () => {
      const requestSpy = vi
        .spyOn(AdminApiService, 'request' as keyof typeof AdminApiService)
        .mockResolvedValue(fakePrompt('PRESCREENING_AT'));

      await AdminApiService.undoAiPrompt('PRESCREENING_AT', 3);

      const [verb, path] = requestSpy.mock.calls[0] as [string, string];
      expect(verb).toBe('POST');
      expect(path).toBe('/api/admin/ai-prompts/PRESCREENING_AT/undo');
      expect(path).not.toBe('/api/admin/ai-prompts/PRESCREENING_AT');
    });
  });
});
