/**
 * gemini-fetch: o helper compartilhado. Sem opções ele loga como sempre (corpo do erro HTTP e mensagem de rede);
 * com `redactErrors` (admissão: o pedido leva transcrição clínica) o log leva só status, classe do erro e tamanho do corpo.
 * Com `signal` abortado não há retry interno.
 */
import { fetchGeminiWithRetry, GeminiApiError } from '../gemini-fetch';

const SENTINELA = 'FRASE-CLINICA-SENTINELA';
const res = (status: number, body: string): Response => ({ ok: status < 400, status, text: async () => body }) as unknown as Response;

describe('fetchGeminiWithRetry', () => {
  let out: string[];
  let fetchMock: jest.Mock;
  const spies: jest.SpyInstance[] = [];

  beforeEach(() => {
    out = [];
    for (const m of ['error', 'warn', 'log', 'info'] as const) spies.push(jest.spyOn(console, m).mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); }));
    fetchMock = jest.fn();
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
  });
  afterEach(() => { spies.splice(0).forEach((s) => s.mockRestore()); });

  describe('SEM a opção (chamadores antigos): comportamento de sempre', () => {
    it('400: loga o CORPO do erro e o GeminiApiError carrega o corpo', async () => {
      fetchMock.mockResolvedValue(res(400, `bad ${SENTINELA}`));
      const err = (await fetchGeminiWithRetry('u', {}, 'Tag').catch((e) => e)) as GeminiApiError;
      expect(err).toBeInstanceOf(GeminiApiError);
      expect(err.body).toContain(SENTINELA);
      expect(err.message).toContain(SENTINELA);
      expect(out.join('\n')).toContain(SENTINELA);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    it('erro de rede: loga a MENSAGEM e repete até 5 vezes', async () => {
      fetchMock.mockRejectedValue(new Error(`socket ${SENTINELA}`));
      await expect(fetchGeminiWithRetry('u', {}, 'Tag')).rejects.toThrow(SENTINELA);
      expect(out.join('\n')).toContain(SENTINELA);
      expect(fetchMock).toHaveBeenCalledTimes(5);
    });
    it('503 repete e depois 200 devolve a resposta', async () => {
      fetchMock.mockResolvedValueOnce(res(503, 'x')).mockResolvedValueOnce(res(200, 'ok'));
      expect((await fetchGeminiWithRetry('u', {}, 'Tag')).status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('COM redactErrors: a sentinela não aparece em lugar nenhum', () => {
    const all = (extra: unknown[] = []): string => [...out, ...extra.map((e) => (e instanceof Error ? `${e.message} ${(e as GeminiApiError).body ?? ''}` : String(e)))].join('\n');

    it('400 com a sentinela no corpo: log só com status e tamanho; o erro sobe sem corpo', async () => {
      fetchMock.mockResolvedValue(res(400, `bad ${SENTINELA}`));
      const err = (await fetchGeminiWithRetry('u', {}, 'Tag', { redactErrors: true }).catch((e) => e)) as GeminiApiError;
      expect(err.status).toBe(400);
      expect(all([err])).not.toContain(SENTINELA);
      expect(out.join('\n')).toContain('HTTP 400');
      expect(out.join('\n')).toMatch(/body \d+ chars, redacted/);
    });
    it('503 repetido até esgotar: nenhum log nem erro leva o corpo', async () => {
      fetchMock.mockResolvedValue(res(503, `overload ${SENTINELA}`));
      const err = (await fetchGeminiWithRetry('u', {}, 'Tag', { redactErrors: true }).catch((e) => e)) as GeminiApiError;
      expect(fetchMock).toHaveBeenCalledTimes(5);
      expect(all([err])).not.toContain(SENTINELA);
    });
    it('erro de rede com a sentinela na mensagem: o log leva só a CLASSE do erro', async () => {
      fetchMock.mockRejectedValue(new TypeError(`fetch failed ${SENTINELA}`));
      await fetchGeminiWithRetry('u', {}, 'Tag', { redactErrors: true }).catch(() => undefined);
      expect(fetchMock).toHaveBeenCalledTimes(5);
      expect(all()).not.toContain(SENTINELA);
      expect(out.join('\n')).toContain('TypeError');
    });
  });

  describe('signal (prazo total)', () => {
    it('abort NÃO é repetido: 1 fetch, o erro original sobe e o log não leva a mensagem', async () => {
      const ctl = new AbortController();
      fetchMock.mockImplementation(async () => { ctl.abort(); throw new DOMException(`aborted ${SENTINELA}`, 'AbortError'); });
      await expect(fetchGeminiWithRetry('u', {}, 'Tag', { redactErrors: true, signal: ctl.signal })).rejects.toMatchObject({ name: 'AbortError' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(out.join('\n')).not.toContain(SENTINELA);
      expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBe(ctl.signal);
    });
  });
});
