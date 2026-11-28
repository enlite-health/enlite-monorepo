import http from 'http';
import type { AddressInfo } from 'net';
import { HttpAttendancePresenceAlertReader } from '../HttpAttendancePresenceAlertReader';
import { PresenceUnavailableError } from '../../application/ports/PresenceReaderPort';

const OCC = '22222222-2222-4222-8222-222222222222';
const WK = '33333333-3333-4333-8333-333333333333';
const SLOT = '44444444-4444-4444-8444-444444444444';
let server: http.Server;
let url: string;
let reply: (status: number, body: unknown) => void;
let seen: { method?: string; path?: string; auth?: string | string[] };
let next: { status: number; body: unknown };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen = { method: req.method, path: req.url, auth: req.headers.authorization };
    res.writeHead(next.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(next.body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  reply = (status, body) => { next = { status, body }; };
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const mk = (over: Partial<ConstructorParameters<typeof HttpAttendancePresenceAlertReader>[0]> = {}) =>
  new HttpAttendancePresenceAlertReader({ baseUrl: url, idToken: async () => ({ Authorization: 'Bearer tok-oidc' }), timeoutMs: 300, ...over });
const reason = async (p: Promise<unknown>): Promise<string> => {
  const e = await p.catch((x) => x);
  expect(e).toBeInstanceOf(PresenceUnavailableError);
  return (e as PresenceUnavailableError).reason;
};

describe('HttpAttendancePresenceAlertReader', () => {
  it('GET /presence/open?on_date_from= com Bearer; mapeia o array de topo', async () => {
    reply(200, [{ occurrence_id: OCC, worker_id: WK, slot_id: SLOT, on_date: '2026-11-25', check_in_at: '2026-11-25T11:00:00Z' }]);
    expect(await mk().openPresence('2026-11-22')).toEqual([{ occurrenceId: OCC, workerId: WK, slotId: SLOT, onDate: '2026-11-25' }]);
    expect([seen.method, seen.path, seen.auth]).toEqual(['GET', '/internal/v1/presence/open?on_date_from=2026-11-22', 'Bearer tok-oidc']);
  });

  it('GET /presence/refused-without-entry?since= (ISO) mapeia o instante da 1ª recusa', async () => {
    reply(200, [{ occurrence_id: OCC, worker_id: WK, first_refused_at: '2026-11-25T11:05:00Z', reason: 'OUTSIDE' }]);
    const since = new Date('2026-11-22T00:00:00Z');
    expect(await mk().refusedWithoutEntry(since)).toEqual([{ occurrenceId: OCC, workerId: WK, firstRefusedAt: '2026-11-25T11:05:00Z' }]);
    expect(seen.path).toBe(`/internal/v1/presence/refused-without-entry?since=${encodeURIComponent(since.toISOString())}`);
  });

  it('modo ATTENDANCE_AUTH=none: não pede ID token nem manda Authorization', async () => {
    reply(200, []);
    const idToken = jest.fn(async () => ({ Authorization: 'Bearer nunca' }));
    expect(await mk({ authNone: true, idToken }).openPresence('2026-11-22')).toEqual([]);
    expect(idToken).not.toHaveBeenCalled();
    expect(seen.auth).toBeUndefined();
  });

  it('fail-closed: sem URL, sem token, 5xx/403, corpo que não é array e item fora do contrato → indisponível com código curto', async () => {
    expect(await reason(mk({ baseUrl: undefined }).openPresence('2026-11-22'))).toBe('sem_url');
    expect(await reason(mk({ idToken: async () => { throw new Error('sem ADC'); } }).openPresence('2026-11-22'))).toBe('sem_id_token');
    reply(503, {});
    expect(await reason(mk().openPresence('2026-11-22'))).toBe('http_503');
    reply(403, {});
    expect(await reason(mk().refusedWithoutEntry(new Date()))).toBe('http_403');
    reply(200, { items: [] });
    expect(await reason(mk().openPresence('2026-11-22'))).toBe('resposta_invalida');
    reply(200, [{ occurrence_id: 'x', worker_id: WK, slot_id: SLOT, on_date: '2026-11-25' }]);
    expect(await reason(mk().openPresence('2026-11-22'))).toBe('resposta_invalida');
    expect(await reason(mk({ baseUrl: 'http://127.0.0.1:1' }).openPresence('2026-11-22'))).toBe('rede');
  });
});
