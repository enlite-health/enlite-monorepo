import http from 'http';
import type { AddressInfo } from 'net';
import { HttpPresenceReader } from '../HttpPresenceReader';
import { PresenceUnavailableError } from '../../application/ports/PresenceReaderPort';

const OCC = '22222222-2222-4222-8222-222222222222';
type Handler = (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void;

let server: http.Server;
let url: string;
let handler: Handler;
let seen: { method?: string; path?: string; auth?: string | string[]; body?: string };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen = { method: req.method, path: req.url, auth: req.headers.authorization, body };
      handler(req, body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const reply = (status: number, payload: unknown): Handler => (_q, _b, res) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
};
const mk = (over: Partial<ConstructorParameters<typeof HttpPresenceReader>[0]> = {}) =>
  new HttpPresenceReader({ baseUrl: url, idToken: async () => ({ Authorization: 'Bearer tok-oidc' }), timeoutMs: 300, ...over });
const reason = async (p: Promise<unknown>): Promise<string> => {
  const e = await p.catch((x) => x);
  expect(e).toBeInstanceOf(PresenceUnavailableError);
  return (e as PresenceUnavailableError).reason;
};

describe('HttpPresenceReader', () => {
  it('POST /internal/v1/presence/lookup com Authorization: Bearer e occurrence_ids; devolve o status', async () => {
    handler = reply(200, [{ occurrence_id: OCC, worker_id: 'w-1', status: 'CLOSED_DECLARED', exit_source: 'DECLARED' }]);
    expect(await mk().statusOf(OCC)).toBe('CLOSED_DECLARED');
    expect(seen.method).toBe('POST');
    expect(seen.path).toBe('/internal/v1/presence/lookup');
    expect(seen.auth).toBe('Bearer tok-oidc');
    expect(JSON.parse(seen.body as string)).toEqual({ occurrence_ids: [OCC] });
  });

  it('NONE (sem linha) volta como NONE, distinto de OPEN', async () => {
    handler = reply(200, [{ occurrence_id: OCC, worker_id: null, status: 'NONE', exit_source: null }]);
    expect(await mk().statusOf(OCC)).toBe('NONE');
    handler = reply(200, [{ occurrence_id: OCC, worker_id: 'w-1', status: 'OPEN', exit_source: null }]);
    expect(await mk().statusOf(OCC)).toBe('OPEN');
  });

  it('timeout (attendance lento) → PresenceUnavailableError "timeout"', async () => {
    handler = () => { /* nunca responde */ };
    expect(await reason(mk({ timeoutMs: 100 }).statusOf(OCC))).toBe('timeout');
  });

  it('5xx, 403 e corpo fora do contrato → indisponível, com código curto', async () => {
    handler = reply(503, { code: 'X' });
    expect(await reason(mk().statusOf(OCC))).toBe('http_503');
    handler = reply(403, {});
    expect(await reason(mk().statusOf(OCC))).toBe('http_403');
    handler = reply(200, [{ occurrence_id: OCC, status: 'INVENTADO' }]);
    expect(await reason(mk().statusOf(OCC))).toBe('resposta_invalida');
    handler = reply(200, []);
    expect(await reason(mk().statusOf(OCC))).toBe('resposta_invalida');
  });

  it('sem URL, sem ID token e rede recusada → indisponível (fail-closed, nunca "fechada")', async () => {
    expect(await reason(mk({ baseUrl: undefined }).statusOf(OCC))).toBe('sem_url');
    expect(await reason(mk({ idToken: async () => { throw new Error('sem ADC'); } }).statusOf(OCC))).toBe('sem_id_token');
    expect(await reason(mk({ baseUrl: 'http://127.0.0.1:1' }).statusOf(OCC))).toBe('rede');
  });
});
