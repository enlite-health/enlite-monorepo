/**
 * O serviço de rascunho (spec 010, F2 2.1/2.2).
 *
 * O que estes testes travam:
 *  1. **A superfície é de 4 métodos.** Não há submissão — submeter sai do
 *     perímetro e depende do `lex`. Um quinto método reprova aqui.
 *  2. **O corpo do erro NÃO é descartado.** O 422 traz a lista de regras e o
 *     409 traz a versão atual; jogar fora deixaria a tela muda.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdminTemplateDraftsApiService, DraftApiError } from '../AdminTemplateDraftsApiService';

const mockGetIdToken = vi.fn().mockResolvedValue('mock-token');
vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({ getIdToken: (...a: unknown[]) => mockGetIdToken(...a) })),
}));

function mockFetch(payload: unknown, status = 200) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: status < 400, status,
    json: () => Promise.resolve(payload),
    headers: { get: () => 'application/json' },
  }) as unknown as typeof fetch;
  return global.fetch as unknown as ReturnType<typeof vi.fn>;
}

const entrada = { slug: 'bienvenida', name: 'B', body: 'Hola {{1}} y chau', category: 'UTILITY', language: 'es-AR' };

describe('AdminTemplateDraftsApiService', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('🔒 expõe exatamente 4 métodos — não existe submissão à Meta', () => {
    expect(Object.keys(AdminTemplateDraftsApiService).sort())
      .toEqual(['archiveDraft', 'createDraft', 'listDrafts', 'updateDraft']);
  });

  it('listDrafts → GET, sem corpo', async () => {
    const f = mockFetch({ success: true, data: { drafts: [] } });
    expect(await AdminTemplateDraftsApiService.listDrafts()).toEqual({ drafts: [] });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/admin/template-drafts');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });

  it('createDraft → POST com o corpo serializado', async () => {
    const f = mockFetch({ success: true, data: { draft: { id: 'a' } } });
    await AdminTemplateDraftsApiService.createDraft(entrada);
    const [, init] = f.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(entrada);
  });

  it('updateDraft → PUT no id, levando a version', async () => {
    const f = mockFetch({ success: true, data: { draft: { id: 'a' } } });
    await AdminTemplateDraftsApiService.updateDraft('abc', { ...entrada, version: 3 });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/admin/template-drafts/abc');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string).version).toBe(3);
  });

  it('archiveDraft → DELETE no id', async () => {
    const f = mockFetch({ success: true, data: null });
    await AdminTemplateDraftsApiService.archiveDraft('abc');
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/admin/template-drafts/abc');
    expect(init.method).toBe('DELETE');
  });

  it('manda o token no Authorization', async () => {
    const f = mockFetch({ success: true, data: { drafts: [] } });
    await AdminTemplateDraftsApiService.listDrafts();
    const [, init] = f.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer mock-token');
  });

  it('sem token não manda header de Authorization vazio', async () => {
    mockGetIdToken.mockResolvedValueOnce(null);
    const f = mockFetch({ success: true, data: { drafts: [] } });
    await AdminTemplateDraftsApiService.listDrafts();
    const [, init] = f.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('422 preserva a LISTA de regras violadas — é o que a tela mostra', async () => {
    mockFetch({ success: false, error: 'Draft rejected by platform rules', problemas: [{ campo: 'body', regra: 'placeholder_no_fim' }] }, 422);
    const err = await AdminTemplateDraftsApiService.createDraft(entrada).catch((e) => e);
    expect(err).toBeInstanceOf(DraftApiError);
    expect(err.status).toBe(422);
    expect(err.problemas).toEqual([{ campo: 'body', regra: 'placeholder_no_fim' }]);
  });

  it('409 de versão preserva a versão atual', async () => {
    mockFetch({ success: false, error: 'versao_desatualizada', versaoAtual: 7 }, 409);
    const err = await AdminTemplateDraftsApiService.updateDraft('a', { ...entrada, version: 1 }).catch((e) => e);
    expect(err.codigo).toBe('versao_desatualizada');
    expect(err.versaoAtual).toBe(7);
    expect(err.problemas).toEqual([]);
  });

  it('resposta sem JSON válido ainda vira DraftApiError com o status', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 502,
      json: () => Promise.reject(new Error('not json')),
    }) as unknown as typeof fetch;
    const err = await AdminTemplateDraftsApiService.listDrafts().catch((e) => e);
    expect(err).toBeInstanceOf(DraftApiError);
    expect(err.status).toBe(502);
    expect(err.message).toBe('HTTP 502');
  });

  it('campos ausentes no erro viram defaults seguros, não undefined solto', async () => {
    mockFetch({ success: false }, 500);
    const err = await AdminTemplateDraftsApiService.listDrafts().catch((e) => e);
    expect(err.problemas).toEqual([]);
    expect(err.versaoAtual).toBeNull();
    expect(err.codigo).toBeNull();
  });

  it('problemas não-array não vira lista corrompida', async () => {
    mockFetch({ success: false, error: 'x', problemas: 'nao-e-array' }, 422);
    const err = await AdminTemplateDraftsApiService.createDraft(entrada).catch((e) => e);
    expect(err.problemas).toEqual([]);
  });
});
