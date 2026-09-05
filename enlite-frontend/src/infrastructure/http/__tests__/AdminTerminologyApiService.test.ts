/**
 * AdminTerminologyApiService — GET /api/admin/terminology/search (spec 016 F3).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdminTerminologyApiService, TerminologyUnavailableError, TerminologyMinQueryLengthError } from '../AdminTerminologyApiService';

const mockGetIdToken = vi.fn().mockResolvedValue('mock-token');
vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({ getIdToken: (...a: unknown[]) => mockGetIdToken(...a) })),
}));

function mockFetch(payload: unknown, status = 200, contentType = 'application/json') {
  global.fetch = vi.fn().mockResolvedValue({
    status,
    json: () => Promise.resolve(payload),
    headers: { get: () => contentType },
  }) as unknown as typeof fetch;
  return global.fetch as unknown as ReturnType<typeof vi.fn>;
}

describe('AdminTerminologyApiService', () => {
  beforeEach(() => { vi.clearAllMocks(); mockGetIdToken.mockResolvedValue('mock-token'); });

  it('search: GET com q e lang=es, devolve candidatos {uri,title}', async () => {
    const f = mockFetch({ success: true, data: { candidates: [{ uri: 'u1', title: 'Esquizofrenia' }] } });
    const out = await AdminTerminologyApiService.search('esquisofrenia');
    expect(out).toEqual([{ uri: 'u1', title: 'Esquizofrenia' }]);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/admin/terminology/search?');
    expect(url).toContain('q=esquisofrenia');
    expect(url).toContain('lang=es');
    expect(url).not.toContain('chapters');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer mock-token');
  });

  it('REQ-21: projeta SÓ uri/title mesmo se o backend vazar campos extras (code/chapter)', async () => {
    mockFetch({ success: true, data: { candidates: [{ uri: 'u1', title: 'X', code: '6A20', chapter: '06' }] } });
    const out = await AdminTerminologyApiService.search('x');
    expect(out).toEqual([{ uri: 'u1', title: 'X' }]);
    expect(out[0]).not.toHaveProperty('code');
    expect(out[0]).not.toHaveProperty('chapter');
  });

  it('chapters: quando informado, entra na query string', async () => {
    const f = mockFetch({ success: true, data: { candidates: [] } });
    await AdminTerminologyApiService.search('x', { chapters: '06,08' });
    const [url] = f.mock.calls[0] as [string];
    expect(url).toContain('chapters=06%2C08');
  });

  it('signal: é repassado ao fetch para permitir abort', async () => {
    const f = mockFetch({ success: true, data: { candidates: [] } });
    const controller = new AbortController();
    await AdminTerminologyApiService.search('x', { signal: controller.signal });
    const [, init] = f.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
  });

  it('503 com code TERMINOLOGY_UNAVAILABLE vira TerminologyUnavailableError (US-4)', async () => {
    mockFetch({ success: false, error: 'catálogo indisponível', code: 'TERMINOLOGY_UNAVAILABLE' }, 503);
    await expect(AdminTerminologyApiService.search('x')).rejects.toBeInstanceOf(TerminologyUnavailableError);
  });

  it('erro genérico do backend (success:false sem code conhecido) vira Error comum, NUNCA TerminologyUnavailableError', async () => {
    mockFetch({ success: false, error: 'Invalid query' }, 400);
    await expect(AdminTerminologyApiService.search('x')).rejects.toThrow('Invalid query');
    await expect(AdminTerminologyApiService.search('x')).rejects.not.toBeInstanceOf(TerminologyUnavailableError);
  });

  it('erro do backend sem campo `error` cai no fallback "HTTP <status>"', async () => {
    mockFetch({ success: false }, 500);
    await expect(AdminTerminologyApiService.search('x')).rejects.toThrow('HTTP 500');
  });

  it('resposta sem content-type JSON vira erro de conexão genérico', async () => {
    mockFetch({}, 502, 'text/html');
    await expect(AdminTerminologyApiService.search('x')).rejects.toThrow(/HTTP 502/);
  });

  it('sem content-type header nenhum (`get` devolve null) cai no mesmo caminho de erro genérico', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      status: 500, json: () => Promise.resolve({}), headers: { get: () => null },
    }) as unknown as typeof fetch;
    await expect(AdminTerminologyApiService.search('x')).rejects.toThrow(/HTTP 500/);
  });

  /**
   * F7 — o piso de tamanho da busca vivia em DUAS fontes: `MIN_CHARS = 2` guardado no front e o
   * `MIN_SEARCH_QUERY_LENGTH` do backend. Hoje concordam; voltam a divergir no dia em que alguém
   * mudar um dos dois. O backend passou a DIZER o número no corpo do 400
   * (`details: { fields:['q'], minQueryLength: 2 }`) — o cliente consome, não guarda.
   */
  it('F7: 400 com details.minQueryLength vira TerminologyMinQueryLengthError carregando o NÚMERO da API', async () => {
    mockFetch({ success: false, error: 'Invalid query', details: { fields: ['q'], minQueryLength: 3 } }, 400);
    await expect(AdminTerminologyApiService.search('ab')).rejects.toBeInstanceOf(TerminologyMinQueryLengthError);
    mockFetch({ success: false, error: 'Invalid query', details: { fields: ['q'], minQueryLength: 3 } }, 400);
    const err = await AdminTerminologyApiService.search('ab').catch((e: unknown) => e);
    expect((err as TerminologyMinQueryLengthError).minQueryLength).toBe(3);
  });

  it('F7: 400 de validação SEM minQueryLength (outro campo inválido) continua sendo Error comum', async () => {
    mockFetch({ success: false, error: 'Invalid query', details: { fields: ['lang'] } }, 400);
    const err = await AdminTerminologyApiService.search('abc').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TerminologyMinQueryLengthError);
  });

  it('F7: `minQueryLength` que não é número (contrato quebrado) NÃO vira piso — cai no erro comum', async () => {
    mockFetch({ success: false, error: 'Invalid query', details: { fields: ['q'], minQueryLength: 'dois' } }, 400);
    const err = await AdminTerminologyApiService.search('ab').catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(TerminologyMinQueryLengthError);
  });

  it('candidates ausente no corpo de sucesso não quebra (devolve [])', async () => {
    mockFetch({ success: true, data: {} });
    const out = await AdminTerminologyApiService.search('x');
    expect(out).toEqual([]);
  });

  it('sem token (getIdToken devolve null): request sai sem Authorization', async () => {
    mockGetIdToken.mockResolvedValueOnce(null);
    const f = mockFetch({ success: true, data: { candidates: [] } });
    await AdminTerminologyApiService.search('x');
    const [, init] = f.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});
