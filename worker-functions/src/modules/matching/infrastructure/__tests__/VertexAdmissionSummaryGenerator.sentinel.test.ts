/**
 * Caminho REAL gerador -> vertex-gemini -> gemini-fetch (só `fetch` e a credencial são dublês): a transcrição é texto clínico e
 * nenhum console.* nem o erro que sobe pode carregar a sentinela. Mata se o gerador deixar de pedir `redactErrors`.
 */
const mockGetAccessToken = jest.fn();
jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({ getProjectId: async () => 'proj-x', getAccessToken: mockGetAccessToken })),
}));

import { VertexAdmissionSummaryGenerator } from '../VertexAdmissionSummaryGenerator';

const SENTINELA = 'FRASE-CLINICA-SENTINELA';
const CATALOGS = { segmentLabels: async () => ['S'], pathologyTypeLabels: async () => ['P'] };

describe('gerador da admissão -> Vertex real: nada clínico no log', () => {
  let out: string[];
  let fetchMock: jest.Mock;
  const spies: jest.SpyInstance[] = [];
  const build = (timeoutMs?: number) => new VertexAdmissionSummaryGenerator(
    { NODE_ENV: 'production', ADMISSION_SUMMARY_PROMPT_DOC_ID: 'D' } as NodeJS.ProcessEnv,
    { promptProvider: { getPrompt: async () => 'prompt' }, catalogs: CATALOGS, timeoutMs },
  );
  const run = (g = build()) => g.generate({ transcript: `transcricao ${SENTINELA}` }).catch((e) => e) as Promise<Error & { reason?: string }>;

  beforeEach(() => {
    out = [];
    for (const m of ['error', 'warn', 'log', 'info'] as const) spies.push(jest.spyOn(console, m).mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); }));
    mockGetAccessToken.mockReset().mockResolvedValue('tok');
    fetchMock = jest.fn();
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
  });
  afterEach(() => { spies.splice(0).forEach((s) => s.mockRestore()); });

  it('400 que ecoa o pedido (sentinela) -> vertex_failed, sem a sentinela em log nem na mensagem', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, text: async () => `invalid request: ${SENTINELA}` });
    const err = await run();
    expect(err).toMatchObject({ reason: 'vertex_failed' });
    expect([...out, err.message].join('\n')).not.toContain(SENTINELA);
    expect(out.join('\n')).toContain('HTTP 400');
  });

  it('erro de rede com a sentinela na mensagem -> vertex_transient, sem a sentinela', async () => {
    fetchMock.mockRejectedValue(new TypeError(`fetch failed ${SENTINELA}`));
    const err = await run();
    expect(err).toMatchObject({ reason: 'vertex_transient' });
    expect([...out, err.message].join('\n')).not.toContain(SENTINELA);
  });

  it('timeout: o fetch fica pendurado até o AbortSignal -> vertex_timeout, 1 fetch só (sem retry interno)', async () => {
    fetchMock.mockImplementation((_u: string, init: RequestInit) => new Promise((_res, rej) => {
      init.signal?.addEventListener('abort', () => rej(new DOMException(`aborted ${SENTINELA}`, 'TimeoutError')));
    }));
    const err = await run(build(30));
    expect(err).toMatchObject({ reason: 'vertex_timeout' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect([...out, err.message].join('\n')).not.toContain(SENTINELA);
  });

  it('credencial ADC quebrada -> vertex_auth_failed (não conta no teto), 0 fetch, sem a mensagem do Google', async () => {
    mockGetAccessToken.mockRejectedValue(new Error('invalid_grant SEGREDO-DE-CREDENCIAL'));
    const err = await run();
    expect(err).toMatchObject({ reason: 'vertex_auth_failed' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect([...out, err.message].join('\n')).not.toContain('SEGREDO-DE-CREDENCIAL');
    mockGetAccessToken.mockResolvedValue(null);
    expect(await run()).toMatchObject({ reason: 'vertex_auth_failed' });
  });
});
