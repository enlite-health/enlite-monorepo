import { TriagePruebaClient, triagePruebaOptsFromEnv } from '../TriagePruebaClient';
import { TriageIndisponivel } from '../../domain/TriagePruebaPort';
import { tetoDiarioFromEnv, TETO_DIARIO_PADRAO } from '../../interfaces/controllers/LuzPruebaController';

const BASE = 'https://triage.exemplo.test';
const ENTRADA = { uid: 'u1', sessao: 's1', mensagem: 'hola', historico: [], turno: 4 };
const SAIDA = { tipo: 'reply', texto: 'ok', ferramentas: [], validadores: [], prestadora: { nome: 'P' } };
const resposta = (status: number, corpo: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => corpo }) as unknown as Response;

describe('TriagePruebaClient (spec 086)', () => {
  it('envia ID token (audience = URL do triage), o gatilho prueba:<uid>:<sessao>#turno-<N> e o corpo {uid,sessao,mensagem,historico}', async () => {
    const idToken = jest.fn().mockResolvedValue({ Authorization: 'Bearer abc' });
    const fetchImpl = jest.fn().mockResolvedValue(resposta(200, SAIDA));
    const out = await new TriagePruebaClient({ baseUrl: `${BASE}/`, idToken, fetchImpl }).turno(ENTRADA);
    expect(out).toEqual(SAIDA);
    expect(idToken).toHaveBeenCalledWith(BASE);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${BASE}/internal/luz/prueba/turn`);
    expect(init.headers).toMatchObject({ Authorization: 'Bearer abc', 'x-enlite-gatilho-id': 'prueba:u1:s1#turno-4' });
    expect(Object.keys(JSON.parse(init.body)).sort()).toEqual(['historico', 'mensagem', 'sessao', 'uid']);
  });

  it('authNone (só teste): não pede token nem manda Authorization', async () => {
    const idToken = jest.fn();
    const fetchImpl = jest.fn().mockResolvedValue(resposta(200, SAIDA));
    await new TriagePruebaClient({ baseUrl: BASE, authNone: true, idToken, fetchImpl }).turno(ENTRADA);
    expect(idToken).not.toHaveBeenCalled();
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it.each([
    ['sem URL (fail-closed)', { baseUrl: '' }, 'sem_url'],
    ['falha ao obter o ID token', { baseUrl: BASE, idToken: jest.fn().mockRejectedValue(new Error('x')) }, 'sem_id_token'],
    ['rede', { baseUrl: BASE, idToken: async () => ({}), fetchImpl: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) }, 'rede'],
    ['5xx', { baseUrl: BASE, idToken: async () => ({}), fetchImpl: jest.fn().mockResolvedValue(resposta(503, {})) }, 'http_503'],
    ['403 do triage', { baseUrl: BASE, idToken: async () => ({}), fetchImpl: jest.fn().mockResolvedValue(resposta(403, {})) }, 'http_403'],
    ['resposta fora do formato', { baseUrl: BASE, idToken: async () => ({}), fetchImpl: jest.fn().mockResolvedValue(resposta(200, { tipo: 'reply' })) }, 'resposta_invalida'],
  ])('lança TriageIndisponivel: %s', async (_nome, opts, causa) => {
    const p = new TriagePruebaClient(opts as never).turno(ENTRADA);
    await expect(p).rejects.toBeInstanceOf(TriageIndisponivel);
    await expect(p).rejects.toMatchObject({ causa });
  });

  it('timeout: aborta o fetch e lança TriageIndisponivel(timeout)', async () => {
    const fetchImpl = jest.fn((_u: string, init: { signal: AbortSignal }) =>
      new Promise((_ok, ko) => init.signal.addEventListener('abort', () => ko(new Error('abort')))));
    await expect(new TriagePruebaClient({ baseUrl: BASE, authNone: true, timeoutMs: 20, fetchImpl: fetchImpl as never }).turno(ENTRADA))
      .rejects.toMatchObject({ causa: 'timeout' });
  });
});

describe('envs só-de-teste (spec 086): ignoradas em produção', () => {
  it('TRIAGE_PRUEBA_AUTH=none vale fora de produção e é IGNORADO com NODE_ENV=production', () => {
    expect(triagePruebaOptsFromEnv({ NODE_ENV: 'test', TRIAGE_PRUEBA_AUTH: 'none', TRIAGE_PRUEBA_URL: BASE }).authNone).toBe(true);
    expect(triagePruebaOptsFromEnv({ NODE_ENV: 'production', TRIAGE_PRUEBA_AUTH: 'none', TRIAGE_PRUEBA_URL: BASE }).authNone).toBe(false);
    expect(triagePruebaOptsFromEnv({ NODE_ENV: 'test', TRIAGE_PRUEBA_URL: BASE }).authNone).toBe(false); // nunca é o default
  });

  it('LUZ_PRUEBA_TETO_DIARIO baixa o teto fora de produção; em produção (ou valor inválido) o teto é 60', () => {
    expect(TETO_DIARIO_PADRAO).toBe(60);
    expect(tetoDiarioFromEnv({ NODE_ENV: 'test', LUZ_PRUEBA_TETO_DIARIO: '3' })).toBe(3);
    expect(tetoDiarioFromEnv({ NODE_ENV: 'production', LUZ_PRUEBA_TETO_DIARIO: '3' })).toBe(60);
    expect(tetoDiarioFromEnv({ NODE_ENV: 'test', LUZ_PRUEBA_TETO_DIARIO: '0' })).toBe(60);
    expect(tetoDiarioFromEnv({ NODE_ENV: 'test' })).toBe(60);
  });
});
