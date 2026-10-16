/**
 * GoogleDocsPromptProvider — Unit Tests
 *
 * Cenários:
 *  1. docId vazio → erro descritivo sobre variáveis de ambiente
 *  2. Drive API falha sem cache → erro descritivo sobre compartilhamento/habilitação
 *  3. Drive API falha com cache stale → retorna cache e loga warning
 *  4. Documento vazio no Drive → erro descritivo
 *  5. Sucesso → retorna conteúdo e popula cache
 *  6. Cache válido (dentro do TTL) → não chama API de novo
 *  7. Cache expirado → chama API novamente
 *  8. clearCache → limpa cache
 */

const mockRequest = jest.fn();

jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getClient: jest.fn().mockResolvedValue({ request: mockRequest }),
  })),
}));

import { GoogleDocsPromptProvider } from '../GoogleDocsPromptProvider';

describe('GoogleDocsPromptProvider', () => {
  const DOC_ID = 'abc123';

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── Erro: docId vazio ─────────────────────────────────────────

  it('deve lançar erro descritivo quando docId é vazio', async () => {
    const provider = new GoogleDocsPromptProvider();

    await expect(provider.getPrompt('')).rejects.toThrow(
      'Prompt document ID não configurado',
    );
    await expect(provider.getPrompt('')).rejects.toThrow(
      'PROMPT_DOC_ID_AT',
    );
    await expect(provider.getPrompt('')).rejects.toThrow(
      'PROMPT_DOC_ID_CUIDADOR',
    );
  });

  // ── Erro: Drive API falha sem cache ───────────────────────────

  it('deve lançar erro descritivo quando Drive API falha e não há cache', async () => {
    mockRequest.mockRejectedValueOnce(new Error('403 Forbidden'));

    const provider = new GoogleDocsPromptProvider();

    await expect(provider.getPrompt(DOC_ID)).rejects.toThrow(
      'Erro ao buscar prompt do Google Drive',
    );
    await expect(
      provider.getPrompt(DOC_ID).catch((e: Error) => e.message),
    ).resolves.toContain(DOC_ID);
  });

  it('deve mencionar service account e Drive API na mensagem de erro', async () => {
    mockRequest.mockRejectedValueOnce(new Error('API not enabled'));

    const provider = new GoogleDocsPromptProvider();

    await expect(provider.getPrompt(DOC_ID)).rejects.toThrow(
      'compartilhado com o service account',
    );
    await expect(
      provider.getPrompt(DOC_ID).catch((e: Error) => e.message),
    ).resolves.toContain('Drive API está habilitada');
  });

  it('deve incluir detalhe do erro original na mensagem', async () => {
    mockRequest.mockRejectedValueOnce(
      new Error('Request had insufficient authentication scopes'),
    );

    const provider = new GoogleDocsPromptProvider();

    await expect(provider.getPrompt(DOC_ID)).rejects.toThrow(
      'insufficient authentication scopes',
    );
  });

  // ── Erro: documento vazio ─────────────────────────────────────

  it('deve lançar erro quando documento retorna conteúdo vazio', async () => {
    mockRequest.mockResolvedValueOnce({ data: '   ' });

    const provider = new GoogleDocsPromptProvider();

    await expect(provider.getPrompt(DOC_ID)).rejects.toThrow(
      'Documento vazio no Google Drive',
    );
  });

  // ── Sucesso ───────────────────────────────────────────────────

  it('deve retornar conteúdo do documento quando API responde com sucesso', async () => {
    mockRequest.mockResolvedValueOnce({ data: 'Prompt content here' });

    const provider = new GoogleDocsPromptProvider();
    const result = await provider.getPrompt(DOC_ID);

    expect(result).toBe('Prompt content here');
  });

  it('deve chamar URL correta do Drive export', async () => {
    mockRequest.mockResolvedValueOnce({ data: 'content' });

    const provider = new GoogleDocsPromptProvider();
    await provider.getPrompt(DOC_ID);

    expect(mockRequest).toHaveBeenCalledWith({
      url: `https://www.googleapis.com/drive/v3/files/${DOC_ID}/export?mimeType=text/plain`,
    });
  });

  it('deve fazer trim do conteúdo retornado', async () => {
    mockRequest.mockResolvedValueOnce({ data: '  content with spaces  \n' });

    const provider = new GoogleDocsPromptProvider();
    const result = await provider.getPrompt(DOC_ID);

    expect(result).toBe('content with spaces');
  });

  // ── Cache ─────────────────────────────────────────────────────

  it('deve retornar cache sem chamar API quando dentro do TTL', async () => {
    mockRequest.mockResolvedValueOnce({ data: 'cached content' });

    const provider = new GoogleDocsPromptProvider(60_000); // 60s TTL
    await provider.getPrompt(DOC_ID);

    mockRequest.mockClear();
    const result = await provider.getPrompt(DOC_ID);

    expect(result).toBe('cached content');
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('deve chamar API novamente quando cache expirou', async () => {
    mockRequest.mockResolvedValue({ data: 'fresh content' });

    const provider = new GoogleDocsPromptProvider(1); // 1ms TTL
    await provider.getPrompt(DOC_ID);

    // Esperar TTL expirar
    await new Promise((r) => setTimeout(r, 10));

    mockRequest.mockClear();
    mockRequest.mockResolvedValueOnce({ data: 'updated content' });
    const result = await provider.getPrompt(DOC_ID);

    expect(result).toBe('updated content');
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  // ── Cache stale como fallback ─────────────────────────────────

  it('deve retornar cache stale quando API falha e cache existe', async () => {
    mockRequest.mockResolvedValueOnce({ data: 'original content' });

    const provider = new GoogleDocsPromptProvider(1); // 1ms TTL
    await provider.getPrompt(DOC_ID);

    await new Promise((r) => setTimeout(r, 10));

    mockRequest.mockRejectedValueOnce(new Error('Network error'));
    const result = await provider.getPrompt(DOC_ID);

    expect(result).toBe('original content');
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('using cached version'),
      expect.any(String),
    );
  });

  it('não deve lançar erro quando API falha mas cache stale existe', async () => {
    mockRequest.mockResolvedValueOnce({ data: 'stale but valid' });

    const provider = new GoogleDocsPromptProvider(1);
    await provider.getPrompt(DOC_ID);

    await new Promise((r) => setTimeout(r, 10));

    mockRequest.mockRejectedValueOnce(new Error('500 Internal'));
    await expect(provider.getPrompt(DOC_ID)).resolves.toBe('stale but valid');
  });

  // ── clearCache ────────────────────────────────────────────────

  it('deve limpar cache e forçar nova chamada à API', async () => {
    mockRequest.mockResolvedValueOnce({ data: 'first' });

    const provider = new GoogleDocsPromptProvider(60_000);
    await provider.getPrompt(DOC_ID);

    provider.clearCache();

    mockRequest.mockResolvedValueOnce({ data: 'second' });
    const result = await provider.getPrompt(DOC_ID);

    expect(result).toBe('second');
  });

  it('deve lançar erro após clearCache se API falhar (sem cache)', async () => {
    mockRequest.mockResolvedValueOnce({ data: 'cached' });

    const provider = new GoogleDocsPromptProvider(60_000);
    await provider.getPrompt(DOC_ID);

    provider.clearCache();

    mockRequest.mockRejectedValueOnce(new Error('Drive unavailable'));
    await expect(provider.getPrompt(DOC_ID)).rejects.toThrow(
      'Erro ao buscar prompt do Google Drive',
    );
  });
});
