/**
 * O serviço do catálogo (spec 010, F1). F1 é espelho: só leitura, e o teste
 * trava que não existe método de escrita — escrita é F2 e depende do `lex`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdminTemplateCatalogApiService } from '../AdminTemplateCatalogApiService';

const mockGetIdToken = vi.fn().mockResolvedValue('mock-token');
vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({ getIdToken: (...a: unknown[]) => mockGetIdToken(...a) })),
}));

function mockFetch(payload: unknown, ok = true) {
  global.fetch = vi.fn().mockResolvedValue({
    ok, status: ok ? 200 : 500,
    json: () => Promise.resolve(payload),
    headers: { get: () => 'application/json' },
  }) as unknown as typeof fetch;
  return global.fetch as unknown as ReturnType<typeof vi.fn>;
}

describe('AdminTemplateCatalogApiService', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('getTemplateCatalog → GET /api/admin/template-catalog', async () => {
    const data = { templates: [] };
    const f = mockFetch({ success: true, data });
    expect(await AdminTemplateCatalogApiService.getTemplateCatalog()).toEqual(data);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/admin/template-catalog');
    expect(init.method).toBe('GET');
  });

  it('manda o token no Authorization', async () => {
    const f = mockFetch({ success: true, data: { templates: [] } });
    await AdminTemplateCatalogApiService.getTemplateCatalog();
    const [, init] = f.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer mock-token');
  });

  it('sem token, não manda header de Authorization vazio', async () => {
    mockGetIdToken.mockResolvedValueOnce(null);
    const f = mockFetch({ success: true, data: { templates: [] } });
    await AdminTemplateCatalogApiService.getTemplateCatalog();
    const [, init] = f.mock.calls[0] as [string, RequestInit];
    expect(init.headers).not.toHaveProperty('Authorization');
  });

  it('erro do backend vira exceção com a mensagem dele', async () => {
    mockFetch({ success: false, error: 'Failed to list template catalog' }, false);
    await expect(AdminTemplateCatalogApiService.getTemplateCatalog()).rejects.toThrow(/Failed to list/);
  });

  it('sem mensagem, usa o status HTTP', async () => {
    mockFetch({ success: false }, false);
    await expect(AdminTemplateCatalogApiService.getTemplateCatalog()).rejects.toThrow(/HTTP 500/);
  });

  it('🔒 não expõe nenhum método de escrita — F2 depende do lex', () => {
    expect(Object.keys(AdminTemplateCatalogApiService)).toEqual(['getTemplateCatalog']);
  });
});
