/**
 * ai-usage.test.ts — spec 082, CA-11: a linha `ai_usage` tem EXATAMENTE as 7 chaves de DF-10 e nenhum texto;
 * `labels` entram no corpo enviado; tag fora do mapa vira `nao_mapeado`.
 */
const mockInfo = jest.fn();
const mockWarn = jest.fn();
jest.mock('@shared/logging/Logger', () => ({ logger: { info: (...a: unknown[]) => mockInfo(...a), warn: (...a: unknown[]) => mockWarn(...a) } }));

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;
jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getAccessToken: jest.fn().mockResolvedValue('test-access-token'),
    getProjectId: jest.fn().mockResolvedValue('test-project'),
  })),
}));

import { loggingAls } from '@shared/logging/als';
import { generateContentVertex } from '../vertex-gemini';
import { attributionFor } from '../ai-usage';

const MARKER_PROMPT = 'MARCADOR_PROMPT_NAO_PODE_VAZAR';
const MARKER_ANSWER = 'MARCADOR_RESPOSTA_NAO_PODE_VAZAR';
const EXPECTED_KEYS = ['event', 'funcao', 'model', 'service', 'setor', 'tokens_in', 'tokens_out'];

function okResponse(usageMetadata: unknown = { promptTokenCount: 120, candidatesTokenCount: 30, thoughtsTokenCount: 7 }): Response {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: MARKER_ANSWER }] } }], usageMetadata }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sentBody(): Record<string, any> {
  return JSON.parse(mockFetch.mock.calls[0][1].body);
}

describe('generateContentVertex — atribuição de IA (spec 082)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('CA-11: a linha ai_usage tem exatamente as 7 chaves e nenhum texto do prompt/resposta', async () => {
    mockFetch.mockResolvedValueOnce(okResponse());
    const res = await generateContentVertex('gemini-2.5-flash', { contents: [{ role: 'user', parts: [{ text: MARKER_PROMPT }] }] }, 'GeminiParser');

    expect(mockInfo).toHaveBeenCalledTimes(1);
    const line = mockInfo.mock.calls[0][0];
    expect(Object.keys(line).sort()).toEqual(EXPECTED_KEYS);
    expect(line).toEqual({
      event: 'ai_usage',
      service: 'worker-functions',
      setor: 'recrutamento',
      funcao: 'parser_vaga',
      model: 'gemini-2.5-flash',
      tokens_in: 120,
      tokens_out: 37, // candidatos + raciocínio
    });
    const serialized = JSON.stringify(mockInfo.mock.calls) + JSON.stringify(mockWarn.mock.calls);
    expect(serialized).not.toContain(MARKER_PROMPT);
    expect(serialized).not.toContain(MARKER_ANSWER);
    // a resposta devolvida ao chamador continua legível (a leitura foi num clone)
    expect(((await res.json()) as any).candidates[0].content.parts[0].text).toBe(MARKER_ANSWER);
  });

  it('injeta labels service/setor/funcao no corpo enviado e preserva o resto do corpo', async () => {
    mockFetch.mockResolvedValueOnce(okResponse());
    await generateContentVertex('m', { contents: [{ parts: [{ text: 'x' }] }], generationConfig: { temperature: 0 } }, 'AdmissionSummary');
    const body = sentBody();
    expect(body.labels).toEqual({ service: 'worker-functions', setor: 'admissao', funcao: 'resumo_admissao' });
    expect(body.generationConfig).toEqual({ temperature: 0 });
  });

  it('mescla labels do chamador sem sobrescrever a chave dele e sem mutar o objeto original', async () => {
    mockFetch.mockResolvedValueOnce(okResponse());
    const original = { contents: [], labels: { setor: 'clinico', extra: 'a' } };
    await generateContentVertex('m', original, 'TalentumDesc');
    expect(sentBody().labels).toEqual({ service: 'worker-functions', setor: 'clinico', funcao: 'talentum_descricao', extra: 'a' });
    expect(original.labels).toEqual({ setor: 'clinico', extra: 'a' });
  });

  it('tag fora do mapa → funcao nao_mapeado, setor plataforma (labels e log)', async () => {
    mockFetch.mockResolvedValueOnce(okResponse());
    await generateContentVertex('m', { contents: [] }, 'TagInventada');
    expect(sentBody().labels).toEqual({ service: 'worker-functions', setor: 'plataforma', funcao: 'nao_mapeado' });
    expect(mockInfo.mock.calls[0][0]).toMatchObject({ funcao: 'nao_mapeado', setor: 'plataforma' });
    expect(attributionFor('toString')).toEqual({ funcao: 'nao_mapeado', setor: 'plataforma' });
  });

  it('usageMetadata ausente → tokens 0, ainda 7 chaves', async () => {
    mockFetch.mockResolvedValueOnce(okResponse(null));
    await generateContentVertex('m', { contents: [] }, 'VertexHealth');
    const line = mockInfo.mock.calls[0][0];
    expect(Object.keys(line).sort()).toEqual(EXPECTED_KEYS);
    expect(line).toMatchObject({ funcao: 'vertex_health', setor: 'plataforma', tokens_in: 0, tokens_out: 0 });
  });

  it('falha ao ler usageMetadata não quebra a chamada: warn sem corpo, resposta devolvida', async () => {
    const broken = { ok: true, status: 200, clone: () => { throw new Error(MARKER_ANSWER); }, json: async () => ({}), text: async () => '' };
    mockFetch.mockResolvedValueOnce(broken);
    await expect(generateContentVertex('m', { contents: [] }, 'GeminiParser')).resolves.toBe(broken);
    expect(mockInfo).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockWarn.mock.calls)).not.toContain(MARKER_ANSWER);
  });

  it('a linha é emitida fora do contexto da request (sem workerId/jobPostingId do mixin)', async () => {
    mockFetch.mockResolvedValueOnce(okResponse());
    let storeAtEmit: unknown = 'unset';
    mockInfo.mockImplementationOnce(() => { storeAtEmit = loggingAls.getStore(); });
    await loggingAls.run({ traceId: 't', workerId: 'w-1' }, () => generateContentVertex('m', { contents: [] }, 'GeminiParser'));
    expect(storeAtEmit).toBeUndefined();
  });
});
