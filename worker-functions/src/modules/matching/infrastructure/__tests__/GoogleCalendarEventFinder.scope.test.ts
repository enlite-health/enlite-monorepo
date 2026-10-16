/**
 * A5-6 — o escopo do token DWD (spec 049 F5, T3). `getAccessToken(sub, fb)` SEM o 3º argumento segue pedindo SÓ o Calendar;
 * o Meet pede o escopo dele SOZINHO. Somar os dois derrubaria o Calendar (o agendamento) enquanto o H2 está aberto.
 * Nenhuma chamada sai da máquina: `fetch` é substituído e a troca do token é simulada.
 */
import { CALENDAR_SCOPE, MEET_SCOPE, getAccessToken, requestDwdAccessToken } from '../GoogleCalendarEventFinder';

type FetchCall = { url: string; body?: string };

function stubGoogle(tokenExchange: { ok: boolean; status?: number; body: unknown }): { calls: FetchCall[]; scopeSigned: () => string } {
  const calls: FetchCall[] = [];
  const stub = jest.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, body: typeof init?.body === 'string' ? init.body : init?.body?.toString() });
    if (u.endsWith('/service-accounts/default/email')) return { ok: true, text: async () => 'sa@e2e.iam.example.test' } as Response;
    if (u.endsWith('/service-accounts/default/token')) return { ok: true, json: async () => ({ access_token: 'sa-token' }) } as Response;
    if (u.includes(':signJwt')) return { ok: true, json: async () => ({ signedJwt: 'jwt' }) } as Response;
    if (u === 'https://oauth2.googleapis.com/token') {
      return {
        ok: tokenExchange.ok,
        status: tokenExchange.status ?? 200,
        json: async () => tokenExchange.body,
        text: async () => JSON.stringify(tokenExchange.body),
      } as Response;
    }
    throw new Error(`chamada inesperada: ${u}`);
  });
  global.fetch = stub as unknown as typeof fetch;
  return {
    calls,
    scopeSigned: () => {
      const sign = calls.find((c) => c.url.includes(':signJwt'));
      return JSON.parse(JSON.parse(sign!.body!).payload).scope as string;
    },
  };
}

describe('getAccessToken — escopo do token DWD', () => {
  const realFetch = global.fetch;
  let warn: jest.SpyInstance;
  const savedCreds = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  beforeEach(() => {
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    global.fetch = realFetch;
    warn.mockRestore();
    if (savedCreds === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    else process.env.GOOGLE_APPLICATION_CREDENTIALS = savedCreds;
  });

  it('A5-6: sem 3º argumento pede EXATAMENTE …/auth/calendar (os chamadores atuais não mudam)', async () => {
    const g = stubGoogle({ ok: true, body: { access_token: 'tok-cal' } });
    await expect(getAccessToken('host@example.test', 'fb@example.test')).resolves.toBe('tok-cal');
    expect(g.scopeSigned()).toBe(CALENDAR_SCOPE);
    expect(g.scopeSigned()).toBe('https://www.googleapis.com/auth/calendar');
  });

  it('A5-6: o Meet pede SÓ meetings.space.readonly — o escopo do Calendar NÃO vai junto', async () => {
    const g = stubGoogle({ ok: true, body: { access_token: 'tok-meet' } });
    await expect(getAccessToken('host@example.test', 'host@example.test', MEET_SCOPE)).resolves.toBe('tok-meet');
    expect(g.scopeSigned()).toBe(MEET_SCOPE);
    expect(g.scopeSigned()).not.toContain('/auth/calendar');
    expect(g.scopeSigned()).not.toContain(' ');
  });

  it('unauthorized_client na troca (escopo não delegado, o H2) é distinguido de falha de rede', async () => {
    stubGoogle({ ok: false, status: 400, body: { error: 'unauthorized_client', error_description: 'Client is unauthorized' } });
    await expect(requestDwdAccessToken('h@example.test', 'h@example.test', MEET_SCOPE)).resolves.toEqual({ error: 'unauthorized_client' });
    // o wrapper antigo continua devolvendo null (comportamento dos chamadores atuais)
    await expect(getAccessToken('h@example.test', 'h@example.test', MEET_SCOPE)).resolves.toBeNull();

    stubGoogle({ ok: false, status: 503, body: { error: 'backend_error' } });
    await expect(requestDwdAccessToken('h@example.test', 'h@example.test', MEET_SCOPE)).resolves.toEqual({ error: 'unavailable' });
  });
});
