/**
 * AnaCareSessionClient.test.ts (2.1/2.2)
 *
 * Cobre: login CSRF, cookie em memória, re-login automático no 403, paginação
 * (page_size=100, NUNCA 500), filtro de universo (agency_id=116) no cliente, e que TODA
 * chamada passa pelo AnaCareRateLimiter compartilhado.
 *
 * REGRA DURA da task: nenhuma chamada de rede real. `fetchImpl` é SEMPRE um mock injetado —
 * nunca o `fetch` global apontando pra `admin.ana.care`. O teste "espião de rede" (2.6) no fim
 * do arquivo prova isso contando as chamadas do mock e conferindo a URL de cada uma.
 */
import { AnaCareSessionClient } from '../AnaCareSessionClient';
import { AnaCareRateLimiter } from '../AnaCareRateLimiter';
import { AnaCareHttpError } from '../AnaCareHttpError';
import { logger } from '@shared/logging';

function makeVirtualClock() {
  let time = 0;
  const now = () => time;
  const sleep = (ms: number) => new Promise<void>((resolve) => { time += ms; resolve(); });
  return { now, sleep };
}

/** Cookie jar mínimo para o servidor fake: lê `Cookie` do request, escreve `Set-Cookie` na resposta. */
function loginPageResponse() {
  return new Response('<html>login form</html>', {
    status: 200,
    headers: { 'set-cookie': 'csrftoken=csrf-abc123; Path=/' },
  });
}

/**
 * Login bem-sucedido do Ana Care responde **302** + `Set-Cookie: sessionid` — medido ao vivo em
 * 16/09/2026. Esta simulação dizia `200`, e foi por isso que o defeito do redirecionamento passou
 * por toda a F2 com 100% de cobertura: com o status errado aqui, nenhum teste podia notar que o
 * `fetch` real seguiria o 302 e perderia o cookie. Simulação que não modela a realidade aprova o
 * defeito que ela mesma esconde.
 */
function loginOkResponse() {
  return new Response('redirect', {
    status: 302,
    headers: { 'set-cookie': 'sessionid=session-xyz789; Path=/', location: '/admin/accounts/' },
  });
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('AnaCareSessionClient — login CSRF + cookie (2.1)', () => {
  it('faz GET da página de login, extrai csrftoken, e POST com credenciais + csrf', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/users/admin/login/') && (!init || init.method === undefined || init.method === 'GET')) {
        return loginPageResponse();
      }
      if (url.endsWith('/users/admin/login/') && init?.method === 'POST') {
        return loginOkResponse();
      }
      throw new Error(`unexpected call: ${url}`);
    });

    const { now, sleep } = makeVirtualClock();
    const client = new AnaCareSessionClient({
      baseUrl: 'https://admin.ana.care',
      username: 'user@enlite.health',
      password: 'secret',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      rateLimiter: new AnaCareRateLimiter({ minIntervalMs: 0, now, sleep }),
    });

    await client.login();

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe('https://admin.ana.care/users/admin/login/');
    expect(calls[1].url).toBe('https://admin.ana.care/users/admin/login/');
    const postBody = String(calls[1].init?.body);
    expect(postBody).toContain('username=user%40enlite.health');
    expect(postBody).toContain('csrfmiddlewaretoken=csrf-abc123');
    const postHeaders = new Headers(calls[1].init?.headers);
    expect(postHeaders.get('Cookie')).toContain('csrftoken=csrf-abc123');
  });

  it('requisição autenticada envia Cookie com sessionid + csrftoken', async () => {
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/users/admin/login/') && (!init?.method || init.method === 'GET')) return loginPageResponse();
      if (url.endsWith('/users/admin/login/') && init?.method === 'POST') return loginOkResponse();
      if (url.includes('/api/shifts/')) return jsonResponse({ count: 0, next: null, previous: null, results: [] });
      throw new Error(`unexpected call: ${url}`);
    });

    const { now, sleep } = makeVirtualClock();
    const client = new AnaCareSessionClient({
      baseUrl: 'https://admin.ana.care',
      username: 'u',
      password: 'p',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      rateLimiter: new AnaCareRateLimiter({ minIntervalMs: 0, now, sleep }),
    });

    await client.requestJson('/api/shifts/', { page_size: 100 });

    const shiftsCall = fetchImpl.mock.calls.find((c) => String(c[0]).includes('/api/shifts/'));
    expect(shiftsCall).toBeDefined();
    const headers = new Headers((shiftsCall![1] as RequestInit)?.headers);
    expect(headers.get('Cookie')).toContain('sessionid=session-xyz789');
  });

  it('403 dispara re-login automático e tenta a requisição original de novo (uma vez)', async () => {
    let shiftsCallCount = 0;
    let loginCount = 0;
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/users/admin/login/') && (!init?.method || init.method === 'GET')) return loginPageResponse();
      if (url.endsWith('/users/admin/login/') && init?.method === 'POST') {
        loginCount += 1;
        return loginOkResponse();
      }
      if (url.includes('/api/shifts/')) {
        shiftsCallCount += 1;
        if (shiftsCallCount === 1) return jsonResponse({ detail: 'expired' }, 403);
        return jsonResponse({ count: 0, next: null, previous: null, results: [] });
      }
      throw new Error(`unexpected call: ${url}`);
    });

    const { now, sleep } = makeVirtualClock();
    const client = new AnaCareSessionClient({
      baseUrl: 'https://admin.ana.care',
      username: 'u',
      password: 'p',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      rateLimiter: new AnaCareRateLimiter({ minIntervalMs: 0, maxAttempts: 1, now, sleep }),
    });

    const result = await client.requestJson<{ results: unknown[] }>('/api/shifts/', { page_size: 100 });
    expect(result.results).toEqual([]);
    expect(shiftsCallCount).toBe(2); // 1a deu 403, 2a (pós re-login) deu certo
    expect(loginCount).toBe(2); // login inicial + re-login após o 403
  });

  it('403 persistente após re-login lança AnaCareHttpError (não tenta indefinidamente)', async () => {
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/users/admin/login/') && (!init?.method || init.method === 'GET')) return loginPageResponse();
      if (url.endsWith('/users/admin/login/') && init?.method === 'POST') return loginOkResponse();
      if (url.includes('/api/shifts/')) return jsonResponse({ detail: 'forbidden' }, 403);
      throw new Error(`unexpected call: ${url}`);
    });

    const { now, sleep } = makeVirtualClock();
    const client = new AnaCareSessionClient({
      baseUrl: 'https://admin.ana.care',
      username: 'u',
      password: 'p',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      rateLimiter: new AnaCareRateLimiter({ minIntervalMs: 0, maxAttempts: 1, now, sleep }),
    });

    await expect(client.requestJson('/api/shifts/', { page_size: 100 })).rejects.toThrow(AnaCareHttpError);
  });
});

describe('AnaCareSessionClient — paginação (2.1)', () => {
  it('pagina com page_size=100 (NUNCA 500) e segue `next` até esgotar', async () => {
    const pageSizesSent: number[] = [];
    let page = 1;
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/users/admin/login/') && (!init?.method || init.method === 'GET')) return loginPageResponse();
      if (url.endsWith('/users/admin/login/') && init?.method === 'POST') return loginOkResponse();
      if (url.includes('/api/shifts/')) {
        const parsed = new URL(url);
        pageSizesSent.push(Number(parsed.searchParams.get('page_size')));
        const currentPage = Number(parsed.searchParams.get('page') ?? '1');
        page = currentPage;
        if (page < 3) {
          return jsonResponse({
            count: 250,
            next: `https://admin.ana.care/api/shifts/?page=${page + 1}&page_size=100`,
            previous: null,
            results: [{ id: `shift-${page}-a` }, { id: `shift-${page}-b` }],
          });
        }
        return jsonResponse({ count: 250, next: null, previous: null, results: [{ id: 'shift-3-a' }] });
      }
      throw new Error(`unexpected call: ${url}`);
    });

    const { now, sleep } = makeVirtualClock();
    const client = new AnaCareSessionClient({
      baseUrl: 'https://admin.ana.care',
      username: 'u',
      password: 'p',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      rateLimiter: new AnaCareRateLimiter({ minIntervalMs: 0, now, sleep }),
    });

    const pages: unknown[][] = [];
    for await (const results of client.paginate<{ id: string }>('/api/shifts/', {})) {
      pages.push(results);
    }

    expect(pages).toHaveLength(3);
    expect(pages.flat()).toHaveLength(5);
    expect(pageSizesSent.every((s) => s === 100)).toBe(true);
    expect(pageSizesSent).not.toContain(500);
  });
});

describe('AnaCareSessionClient — filtro de universo D340 no cliente (2.1)', () => {
  it('listShifts filtra por patient.agency === 116, mesmo com ?agency= ignorado pelo servidor', async () => {
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/users/admin/login/') && (!init?.method || init.method === 'GET')) return loginPageResponse();
      if (url.endsWith('/users/admin/login/') && init?.method === 'POST') return loginOkResponse();
      if (url.includes('/api/shifts/')) {
        return jsonResponse({
          count: 3,
          next: null,
          previous: null,
          results: [
            {
              id: 1,
              start: '2026-09-01T13:00:00-06:00',
              end: '2026-09-01T17:00:00-06:00',
              checkin: null,
              checkout: null,
              checkin_source: null,
              checkout_source: null,
              checkin_delay: null,
              duration: null,
              month: '2026-09',
              is_finalized: false,
              patient: { id: 10, agency: 116, document_type: 'DNI', document_number: '1', first_name: 'A', last_name: 'B' },
              nurse: { id: 100, first_name: 'N', last_name: 'M' },
            },
            {
              id: 2,
              start: '2026-09-01T13:00:00-06:00',
              end: '2026-09-01T17:00:00-06:00',
              checkin: null,
              checkout: null,
              checkin_source: null,
              checkout_source: null,
              checkin_delay: null,
              duration: null,
              month: '2026-09',
              is_finalized: false,
              // outra agência — tem que ser descartado pelo filtro no cliente
              patient: { id: 11, agency: 999, document_type: 'DNI', document_number: '2', first_name: 'C', last_name: 'D' },
              nurse: { id: 101, first_name: 'N2', last_name: 'M2' },
            },
          ],
        });
      }
      throw new Error(`unexpected call: ${url}`);
    });

    const { now, sleep } = makeVirtualClock();
    const client = new AnaCareSessionClient({
      baseUrl: 'https://admin.ana.care',
      username: 'u',
      password: 'p',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      rateLimiter: new AnaCareRateLimiter({ minIntervalMs: 0, now, sleep }),
    });

    const { shifts } = await client.listShifts({ from: '2026-09-01', to: '2026-09-30' });
    expect(shifts).toHaveLength(1);
    expect(shifts[0].anaCarePatientId).toBe('10');
  });

  it('1ª perna sozinha: patient.agency===116 entra mesmo com prestador de OUTRA agência', async () => {
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/users/admin/login/') && (!init?.method || init.method === 'GET')) return loginPageResponse();
      if (url.endsWith('/users/admin/login/') && init?.method === 'POST') return loginOkResponse();
      if (url.includes('/api/shifts/')) {
        return jsonResponse({
          count: 1,
          next: null,
          previous: null,
          results: [
            {
              id: 1,
              start: '2026-09-01T13:00:00-06:00',
              end: '2026-09-01T17:00:00-06:00',
              checkin: null,
              checkout: null,
              checkin_source: null,
              checkout_source: null,
              checkin_delay: null,
              duration: null,
              month: '2026-09',
              is_finalized: false,
              patient: { id: 10, agency: 116, document_type: 'DNI', document_number: '1', first_name: 'A', last_name: 'B' },
              // prestador de OUTRA agência — não pode derrubar a 1ª perna (paciente já é 116)
              nurse: { id: 100, agency: 5, first_name: 'N', last_name: 'M' },
            },
          ],
        });
      }
      throw new Error(`unexpected call: ${url}`);
    });

    const { now, sleep } = makeVirtualClock();
    const client = new AnaCareSessionClient({
      baseUrl: 'https://admin.ana.care',
      username: 'u',
      password: 'p',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      rateLimiter: new AnaCareRateLimiter({ minIntervalMs: 0, now, sleep }),
    });

    const { shifts } = await client.listShifts({ from: '2026-09-01', to: '2026-09-30' });
    expect(shifts).toHaveLength(1);
    expect(shifts[0].anaCarePatientId).toBe('10');
  });

  it('2ª perna do OR (D340): patient.agency nulo + prestador agency===116 ENTRA no universo', async () => {
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/users/admin/login/') && (!init?.method || init.method === 'GET')) return loginPageResponse();
      if (url.endsWith('/users/admin/login/') && init?.method === 'POST') return loginOkResponse();
      if (url.includes('/api/shifts/')) {
        return jsonResponse({
          count: 2,
          next: null,
          previous: null,
          results: [
            {
              id: 1,
              start: '2026-09-01T13:00:00-06:00',
              end: '2026-09-01T17:00:00-06:00',
              checkin: null,
              checkout: null,
              checkin_source: null,
              checkout_source: null,
              checkin_delay: null,
              duration: null,
              month: '2026-09',
              is_finalized: false,
              // paciente com agência NULA (71% dos turnos, F10) + prestador da 116 — F7 medido
              patient: { id: 90, agency: null, document_type: null, document_number: null, first_name: 'E', last_name: 'F' },
              nurse: { id: 200, agency: 116, first_name: 'N3', last_name: 'M3' },
            },
            {
              id: 2,
              start: '2026-09-01T13:00:00-06:00',
              end: '2026-09-01T17:00:00-06:00',
              checkin: null,
              checkout: null,
              checkin_source: null,
              checkout_source: null,
              checkin_delay: null,
              duration: null,
              month: '2026-09',
              is_finalized: false,
              // paciente com agência nula + prestador de OUTRA agência — fora do universo automático
              patient: { id: 91, agency: null, document_type: null, document_number: null, first_name: 'G', last_name: 'H' },
              nurse: { id: 201, agency: 999, first_name: 'N4', last_name: 'M4' },
            },
          ],
        });
      }
      throw new Error(`unexpected call: ${url}`);
    });

    const { now, sleep } = makeVirtualClock();
    const client = new AnaCareSessionClient({
      baseUrl: 'https://admin.ana.care',
      username: 'u',
      password: 'p',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      rateLimiter: new AnaCareRateLimiter({ minIntervalMs: 0, now, sleep }),
    });

    const { shifts } = await client.listShifts({ from: '2026-09-01', to: '2026-09-30' });
    expect(shifts).toHaveLength(1);
    expect(shifts[0].anaCarePatientId).toBe('90');
  });

  it('listShifts manda `from`/`to` como `min_date`/`max_date`, sem `month` — a tradução mês→faixa é responsabilidade de quem chama o cliente (AnaCareShiftsSourceReal), não deste cliente', async () => {
    const urlsCalled: string[] = [];
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/users/admin/login/') && (!init?.method || init.method === 'GET')) return loginPageResponse();
      if (url.endsWith('/users/admin/login/') && init?.method === 'POST') return loginOkResponse();
      if (url.includes('/api/shifts/')) {
        urlsCalled.push(url);
        return jsonResponse({ count: 0, next: null, previous: null, results: [] });
      }
      throw new Error(`unexpected call: ${url}`);
    });
    const { now, sleep } = makeVirtualClock();
    const client = new AnaCareSessionClient({
      baseUrl: 'https://admin.ana.care',
      username: 'u',
      password: 'p',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      rateLimiter: new AnaCareRateLimiter({ minIntervalMs: 0, now, sleep }),
    });

    await client.listShifts({ from: '2026-09-01', to: '2026-09-30' });

    expect(urlsCalled).toHaveLength(1);
    const parsed = new URL(urlsCalled[0]);
    expect(parsed.searchParams.get('min_date')).toBe('2026-09-01');
    expect(parsed.searchParams.get('max_date')).toBe('2026-09-30');
    expect(parsed.searchParams.get('month')).toBeNull();
  });

  it('listShifts repassa patientId como filtro `patient` (nunca `patient_id` — ignorado em silêncio pelo servidor, medido 17/09)', async () => {
    const urlsCalled: string[] = [];
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/users/admin/login/') && (!init?.method || init.method === 'GET')) return loginPageResponse();
      if (url.endsWith('/users/admin/login/') && init?.method === 'POST') return loginOkResponse();
      if (url.includes('/api/shifts/')) {
        urlsCalled.push(url);
        return jsonResponse({ count: 0, next: null, previous: null, results: [] });
      }
      throw new Error(`unexpected call: ${url}`);
    });
    const { now, sleep } = makeVirtualClock();
    const client = new AnaCareSessionClient({
      baseUrl: 'https://admin.ana.care',
      username: 'u',
      password: 'p',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      rateLimiter: new AnaCareRateLimiter({ minIntervalMs: 0, now, sleep }),
    });

    await client.listShifts({ from: '2026-09-01', to: '2026-09-30', patientId: '42' });
    expect(urlsCalled[0]).toContain('patient=42');
    expect(urlsCalled[0]).not.toContain('patient_id=');
  });

  it('listShifts repassa reservationId como filtro `reservation_id` quando informado', async () => {
    const urlsCalled: string[] = [];
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/users/admin/login/') && (!init?.method || init.method === 'GET')) return loginPageResponse();
      if (url.endsWith('/users/admin/login/') && init?.method === 'POST') return loginOkResponse();
      if (url.includes('/api/shifts/')) {
        urlsCalled.push(url);
        return jsonResponse({ count: 0, next: null, previous: null, results: [] });
      }
      throw new Error(`unexpected call: ${url}`);
    });
    const { now, sleep } = makeVirtualClock();
    const client = new AnaCareSessionClient({
      baseUrl: 'https://admin.ana.care',
      username: 'u',
      password: 'p',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      rateLimiter: new AnaCareRateLimiter({ minIntervalMs: 0, now, sleep }),
    });

    await client.listShifts({ from: '2026-09-01', to: '2026-09-30', reservationId: '99' });
    expect(urlsCalled[0]).toContain('reservation_id=99');
  });
});

describe('AnaCareSessionClient — construção e casos de borda', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('sem opções explícitas, usa env (ANACARE_USERNAME/ANACARE_PASS/ANACARE_BASE_URL) e defaults de fetch/rateLimiter', () => {
    process.env.ANACARE_USERNAME = 'env-user';
    process.env.ANACARE_PASS = 'env-pass';
    delete process.env.ANACARE_BASE_URL;
    // Só construir (sem chamar login/requestJson) — prova que os `??` de default não lançam
    // e não tocam rede; o "espião" real é `realFetchSpy` não ser chamado neste teste.
    const realFetchSpy = jest.spyOn(global, 'fetch');
    expect(() => new AnaCareSessionClient()).not.toThrow();
    expect(realFetchSpy).not.toHaveBeenCalled();
    realFetchSpy.mockRestore();
  });

  it('lança sem ANACARE_USERNAME/ANACARE_PASS (nem opção, nem env) — credencial D350 obrigatória', () => {
    delete process.env.ANACARE_USERNAME;
    delete process.env.ANACARE_PASS;
    expect(() => new AnaCareSessionClient({ baseUrl: 'https://admin.ana.care' })).toThrow(/ANACARE_USERNAME/);
  });

  it('ignora um Set-Cookie malformado (sem "=") sem quebrar o parsing dos válidos', async () => {
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/users/admin/login/') && (!init?.method || init.method === 'GET')) {
        const headers = new Headers();
        headers.append('set-cookie', 'HttpOnly'); // malformado: sem "="
        headers.append('set-cookie', 'csrftoken=csrf-ok; Path=/');
        return new Response('<html/>', { status: 200, headers });
      }
      if (url.endsWith('/users/admin/login/') && init?.method === 'POST') return loginOkResponse();
      throw new Error(`unexpected call: ${url}`);
    });
    const { now, sleep } = makeVirtualClock();
    const client = new AnaCareSessionClient({
      baseUrl: 'https://admin.ana.care',
      username: 'u',
      password: 'p',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      rateLimiter: new AnaCareRateLimiter({ minIntervalMs: 0, maxAttempts: 1, now, sleep }),
    });
    await expect(client.login()).resolves.toBeUndefined();
  });

  it('login lança quando a página não devolve csrftoken', async () => {
    const fetchImpl = jest.fn(async (url: string) => {
      if (url.endsWith('/users/admin/login/')) return new Response('sem cookie', { status: 200 });
      throw new Error(`unexpected call: ${url}`);
    });
    const { now, sleep } = makeVirtualClock();
    const client = new AnaCareSessionClient({
      baseUrl: 'https://admin.ana.care',
      username: 'u',
      password: 'p',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      rateLimiter: new AnaCareRateLimiter({ minIntervalMs: 0, maxAttempts: 1, now, sleep }),
    });
    await expect(client.login()).rejects.toThrow(/csrftoken ausente/);
  });

  it('login lança AnaCareHttpError quando o POST não devolve sessionid', async () => {
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/users/admin/login/') && (!init?.method || init.method === 'GET')) return loginPageResponse();
      if (url.endsWith('/users/admin/login/') && init?.method === 'POST') {
        return new Response('credenciais inválidas', { status: 401 });
      }
      throw new Error(`unexpected call: ${url}`);
    });
    const { now, sleep } = makeVirtualClock();
    const client = new AnaCareSessionClient({
      baseUrl: 'https://admin.ana.care',
      username: 'u',
      password: 'wrong',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      rateLimiter: new AnaCareRateLimiter({ minIntervalMs: 0, maxAttempts: 1, now, sleep }),
    });
    await expect(client.login()).rejects.toThrow(AnaCareHttpError);
  });

  it('getRawShift devolve null em 404 e propaga outros erros', async () => {
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/users/admin/login/') && (!init?.method || init.method === 'GET')) return loginPageResponse();
      if (url.endsWith('/users/admin/login/') && init?.method === 'POST') return loginOkResponse();
      if (url.includes('/api/shifts/missing/')) return jsonResponse({ detail: 'not found' }, 404);
      if (url.includes('/api/shifts/broken/')) return jsonResponse({ detail: 'server error' }, 500);
      throw new Error(`unexpected call: ${url}`);
    });
    const { now, sleep } = makeVirtualClock();
    const client = new AnaCareSessionClient({
      baseUrl: 'https://admin.ana.care',
      username: 'u',
      password: 'p',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      rateLimiter: new AnaCareRateLimiter({ minIntervalMs: 0, maxAttempts: 1, now, sleep }),
    });

    expect(await client.getRawShift('missing')).toBeNull();
    await expect(client.getRawShift('broken')).rejects.toThrow(AnaCareHttpError);
  });

  it('iterateAgencyShiftsRaw filtra por agência ao longo de páginas', async () => {
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/users/admin/login/') && (!init?.method || init.method === 'GET')) return loginPageResponse();
      if (url.endsWith('/users/admin/login/') && init?.method === 'POST') return loginOkResponse();
      if (url.includes('/api/shifts/')) {
        return jsonResponse({
          count: 2,
          next: null,
          previous: null,
          results: [
            { id: 1, patient: { id: 10, agency: 116 }, nurse: { id: 1 } },
            { id: 2, patient: { id: 11, agency: 5 }, nurse: { id: 2 } },
          ],
        });
      }
      throw new Error(`unexpected call: ${url}`);
    });
    const { now, sleep } = makeVirtualClock();
    const client = new AnaCareSessionClient({
      baseUrl: 'https://admin.ana.care',
      username: 'u',
      password: 'p',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      rateLimiter: new AnaCareRateLimiter({ minIntervalMs: 0, now, sleep }),
    });

    const pages: unknown[][] = [];
    for await (const page of client.iterateAgencyShiftsRaw()) pages.push(page);
    expect(pages.flat()).toHaveLength(1);
  });

  it('paginação: 403 na segunda página (URL absoluta de `next`) dispara re-login e repete', async () => {
    let secondPageCalls = 0;
    let loginCount = 0;
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/users/admin/login/') && (!init?.method || init.method === 'GET')) return loginPageResponse();
      if (url.endsWith('/users/admin/login/') && init?.method === 'POST') {
        loginCount += 1;
        return loginOkResponse();
      }
      if (url.includes('page=2')) {
        secondPageCalls += 1;
        if (secondPageCalls === 1) return jsonResponse({ detail: 'expired' }, 403);
        return jsonResponse({ count: 0, next: null, previous: null, results: [] });
      }
      if (url.includes('/api/shifts/')) {
        return jsonResponse({
          count: 1,
          next: 'https://admin.ana.care/api/shifts/?page=2&page_size=100',
          previous: null,
          results: [{ id: 1, patient: { id: 1, agency: 116 }, nurse: { id: 1 } }],
        });
      }
      throw new Error(`unexpected call: ${url}`);
    });
    const { now, sleep } = makeVirtualClock();
    const client = new AnaCareSessionClient({
      baseUrl: 'https://admin.ana.care',
      username: 'u',
      password: 'p',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      rateLimiter: new AnaCareRateLimiter({ minIntervalMs: 0, maxAttempts: 1, now, sleep }),
    });

    const pages: unknown[][] = [];
    for await (const page of client.paginate('/api/shifts/', {})) pages.push(page);
    expect(pages).toHaveLength(2);
    expect(secondPageCalls).toBe(2);
    expect(loginCount).toBe(2); // login inicial + re-login pós-403 na 2a página
  });

  it('paginação: 403 persistente na URL absoluta (mesmo após re-login) lança AnaCareHttpError', async () => {
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/users/admin/login/') && (!init?.method || init.method === 'GET')) return loginPageResponse();
      if (url.endsWith('/users/admin/login/') && init?.method === 'POST') return loginOkResponse();
      if (url.includes('page=2')) return jsonResponse({ detail: 'forbidden' }, 403);
      if (url.includes('/api/shifts/')) {
        return jsonResponse({
          count: 1,
          next: 'https://admin.ana.care/api/shifts/?page=2&page_size=100',
          previous: null,
          results: [{ id: 1, patient: { id: 1, agency: 116 }, nurse: { id: 1 } }],
        });
      }
      throw new Error(`unexpected call: ${url}`);
    });
    const { now, sleep } = makeVirtualClock();
    const client = new AnaCareSessionClient({
      baseUrl: 'https://admin.ana.care',
      username: 'u',
      password: 'p',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      rateLimiter: new AnaCareRateLimiter({ minIntervalMs: 0, maxAttempts: 1, now, sleep }),
    });

    const iterator = client.paginate('/api/shifts/', {})[Symbol.asyncIterator]();
    await iterator.next(); // primeira página ok
    await expect(iterator.next()).rejects.toThrow(AnaCareHttpError);
  });

  it('erro de rede (fetchImpl lança) vira AnaCareTimeoutError, tratado como transiente pelo limiter', async () => {
    let calls = 0;
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/users/admin/login/') && (!init?.method || init.method === 'GET')) {
        calls += 1;
        if (calls === 1) throw new Error('ECONNRESET');
        return loginPageResponse();
      }
      if (url.endsWith('/users/admin/login/') && init?.method === 'POST') return loginOkResponse();
      throw new Error(`unexpected call: ${url}`);
    });
    const { now, sleep } = makeVirtualClock();
    const client = new AnaCareSessionClient({
      baseUrl: 'https://admin.ana.care',
      username: 'u',
      password: 'p',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      rateLimiter: new AnaCareRateLimiter({ minIntervalMs: 0, maxAttempts: 3, now, sleep }),
    });

    await expect(client.login()).resolves.toBeUndefined();
    expect(calls).toBe(2); // 1a tentativa deu erro de rede, retry teve sucesso
  });

  it('circuitBreakerOpen reflete o estado do rate limiter interno', async () => {
    const { now, sleep } = makeVirtualClock();
    const limiter = new AnaCareRateLimiter({ minIntervalMs: 0, maxAttempts: 1, breakerThreshold: 1, now, sleep });
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/users/admin/login/') && (!init?.method || init.method === 'GET')) return loginPageResponse();
      if (url.endsWith('/users/admin/login/') && init?.method === 'POST') return loginOkResponse();
      if (url.includes('/api/shifts/')) return jsonResponse({ detail: 'boom' }, 500);
      throw new Error(`unexpected call: ${url}`);
    });
    const client = new AnaCareSessionClient({
      baseUrl: 'https://admin.ana.care',
      username: 'u',
      password: 'p',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      rateLimiter: limiter,
    });

    expect(client.circuitBreakerOpen).toBe(false);
    await expect(client.requestJson('/api/shifts/', {})).rejects.toThrow();
    expect(client.circuitBreakerOpen).toBe(true);
  });

  it('safeText nunca lança mesmo se response.text() falhar (corpo já consumido)', async () => {
    const brokenResponse = {
      ok: false,
      status: 500,
      headers: new Headers(),
      text: async () => {
        throw new Error('body already consumed');
      },
    } as unknown as Response;
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/users/admin/login/') && (!init?.method || init.method === 'GET')) return loginPageResponse();
      if (url.endsWith('/users/admin/login/') && init?.method === 'POST') return loginOkResponse();
      if (url.includes('/api/shifts/')) return brokenResponse;
      throw new Error(`unexpected call: ${url}`);
    });
    const { now, sleep } = makeVirtualClock();
    const client = new AnaCareSessionClient({
      baseUrl: 'https://admin.ana.care',
      username: 'u',
      password: 'p',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      rateLimiter: new AnaCareRateLimiter({ minIntervalMs: 0, maxAttempts: 1, now, sleep }),
    });

    await expect(client.requestJson('/api/shifts/', {})).rejects.toThrow(AnaCareHttpError);
  });
});

describe('AnaCareSessionClient — condição de corrida no estado de sessão (achado 1)', () => {
  it('N chamadas concorrentes contra cliente recém-criado (não logado) disparam login só UMA vez', async () => {
    let loginPostCount = 0;
    let shiftsCallCount = 0;
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/users/admin/login/') && (!init?.method || init.method === 'GET')) {
        return loginPageResponse();
      }
      if (url.endsWith('/users/admin/login/') && init?.method === 'POST') {
        loginPostCount += 1;
        return loginOkResponse();
      }
      if (url.includes('/api/shifts/')) {
        shiftsCallCount += 1;
        return jsonResponse({ count: 0, next: null, previous: null, results: [] });
      }
      throw new Error(`unexpected call: ${url}`);
    });

    const { now, sleep } = makeVirtualClock();
    // rateLimiter COMPARTILHADO entre as N chamadas concorrentes — é o mesmo client, e é
    // exatamente esse compartilhamento (fila + estado) que a correção precisa proteger.
    const client = new AnaCareSessionClient({
      baseUrl: 'https://admin.ana.care',
      username: 'u',
      password: 'p',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      rateLimiter: new AnaCareRateLimiter({ minIntervalMs: 0, now, sleep }),
    });

    // 5 chamadas concorrentes (Promise.all) contra um client que NUNCA logou — é a janela
    // onde, sem a correção, duas ou mais veem `loggedIn===false` ao mesmo tempo e disparam
    // login duplicado (ou uma limpa o cookie que a outra acabou de escrever).
    await Promise.all([
      client.requestJson('/api/shifts/', { page_size: 100 }),
      client.requestJson('/api/shifts/', { page_size: 100 }),
      client.requestJson('/api/shifts/', { page_size: 100 }),
      client.requestJson('/api/shifts/', { page_size: 100 }),
      client.requestJson('/api/shifts/', { page_size: 100 }),
    ]);

    expect(loginPostCount).toBe(1);
    expect(shiftsCallCount).toBe(5);
  });
});

describe('AnaCareSessionClient — logging estruturado no re-login por 403 (achado 4)', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined as unknown as ReturnType<typeof logger.warn>);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('loga (logger.warn, nunca console.*) quando um 403 dispara o re-login — sem PII nem corpo de resposta', async () => {
    const realConsoleWarn = jest.spyOn(console, 'warn');
    let shiftsCallCount = 0;
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/users/admin/login/') && (!init?.method || init.method === 'GET')) return loginPageResponse();
      if (url.endsWith('/users/admin/login/') && init?.method === 'POST') return loginOkResponse();
      if (url.includes('/api/shifts/')) {
        shiftsCallCount += 1;
        if (shiftsCallCount === 1) {
          return jsonResponse({ detail: 'expired', patient: { first_name: 'NUNCA-DEVE-VAZAR' } }, 403);
        }
        return jsonResponse({ count: 0, next: null, previous: null, results: [] });
      }
      throw new Error(`unexpected call: ${url}`);
    });

    const { now, sleep } = makeVirtualClock();
    const client = new AnaCareSessionClient({
      baseUrl: 'https://admin.ana.care',
      username: 'u',
      password: 'p',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      rateLimiter: new AnaCareRateLimiter({ minIntervalMs: 0, maxAttempts: 1, now, sleep }),
    });

    await client.requestJson('/api/shifts/', {});

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ msg: expect.stringContaining('re-login') }),
    );
    // PII-safety: nenhuma chamada de log carrega o corpo da resposta (onde iria o nome do paciente).
    for (const call of warnSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('NUNCA-DEVE-VAZAR');
    }
    expect(realConsoleWarn).not.toHaveBeenCalled();
    realConsoleWarn.mockRestore();
  });
});

describe('AnaCareSessionClient — retry transiente pós-relogin não relogina de novo (bug nomeado)', () => {
  it('403 dispara relogin (funciona) e o fetch seguinte dá 5xx transiente: login é chamado 1 vez, não uma vez por tentativa de retry', async () => {
    let loginPostCount = 0;
    let shiftsCallCount = 0;
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/users/admin/login/') && (!init?.method || init.method === 'GET')) return loginPageResponse();
      if (url.endsWith('/users/admin/login/') && init?.method === 'POST') {
        loginPostCount += 1;
        return loginOkResponse();
      }
      if (url.includes('/api/shifts/')) {
        shiftsCallCount += 1;
        if (shiftsCallCount === 1) return jsonResponse({ detail: 'expired' }, 403); // dispara re-login
        if (shiftsCallCount === 2) return jsonResponse({ detail: 'boom' }, 503); // transiente PÓS relogin
        return jsonResponse({ count: 0, next: null, previous: null, results: [] }); // 3ª tentativa: ok
      }
      throw new Error(`unexpected call: ${url}`);
    });

    const { now, sleep } = makeVirtualClock();
    const client = new AnaCareSessionClient({
      baseUrl: 'https://admin.ana.care',
      username: 'u',
      password: 'p',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      // maxAttempts alto o bastante para o retry transiente (503) ter uma 2ª chance dentro
      // do MESMO schedule() do relogin — é exatamente esse retry que não pode relogar de novo.
      rateLimiter: new AnaCareRateLimiter({ minIntervalMs: 0, maxAttempts: 3, now, sleep }),
    });

    // Login inicial já feito e contado à parte — o que importa aqui é o relogin do 403 em diante.
    await client.login();
    loginPostCount = 0;

    const result = await client.requestJson<{ results: unknown[] }>('/api/shifts/', { page_size: 100 });

    expect(result.results).toEqual([]);
    expect(shiftsCallCount).toBe(3); // 403, depois 503 transiente, depois 200
    expect(loginPostCount).toBe(1); // 1 único re-login — o retry do 503 reusa a sessão, não relога
  });
});

describe('AnaCareSessionClient — espião de rede: 0 chamadas reais (2.6)', () => {
  it('toda chamada HTTP passa pelo fetchImpl injetado — nunca o fetch global real', async () => {
    const realFetchSpy = jest.spyOn(global, 'fetch');
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/users/admin/login/') && (!init?.method || init.method === 'GET')) return loginPageResponse();
      if (url.endsWith('/users/admin/login/') && init?.method === 'POST') return loginOkResponse();
      if (url.includes('/api/shifts/')) return jsonResponse({ count: 0, next: null, previous: null, results: [] });
      throw new Error(`unexpected call: ${url}`);
    });

    const { now, sleep } = makeVirtualClock();
    const client = new AnaCareSessionClient({
      baseUrl: 'https://admin.ana.care',
      username: 'u',
      password: 'p',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      rateLimiter: new AnaCareRateLimiter({ minIntervalMs: 0, now, sleep }),
    });

    await client.listShifts({ from: '2026-09-01', to: '2026-09-30' });

    expect(realFetchSpy).not.toHaveBeenCalled();
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(0);
    realFetchSpy.mockRestore();
  });
});

/**
 * Regressão do defeito medido ao vivo na stage em 16/09/2026: o login falhava com credencial
 * CORRETA. Causa: o `fetch` do Node segue redirecionamento por padrão; o login responde
 * `302 + Set-Cookie: sessionid`, o 302 era seguido, o `Set-Cookie` se perdia, a página de destino
 * não reconhecia a sessão e devolvia o formulário de login com 200.
 *
 * Estes testes provam o CONTRATO que impede o defeito (`redirect: 'manual'` em toda requisição, e
 * 302 tratado como sessão expirada). Eles NÃO provam o comportamento do `fetch` real — isso é
 * impossível com `fetchImpl` simulado, e foi exatamente esse ponto cego que deixou o defeito passar
 * com 100% de cobertura. A prova do comportamento real é o teste de fumaça contra o Ana Care.
 */
describe('AnaCareSessionClient — redirecionamento manual (regressão da stage, 16/09)', () => {
  it('TODA requisição sai com redirect: manual — sem isso o fetch segue o 302 e perde o sessionid', async () => {
    const inits: (RequestInit | undefined)[] = [];
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      inits.push(init);
      if (url.endsWith('/users/admin/login/')) {
        return init?.method === 'POST' ? loginOkResponse() : loginPageResponse();
      }
      return jsonResponse({ count: 0, next: null, results: [] });
    });

    const { now, sleep } = makeVirtualClock();
    const client = new AnaCareSessionClient({
      baseUrl: 'https://admin.ana.care',
      username: 'user@enlite.health',
      password: 'secret',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      rateLimiter: new AnaCareRateLimiter({ minIntervalMs: 0, now, sleep }),
    });

    await client.listShifts({ from: '2026-09-01', to: '2026-09-30' });

    expect(inits.length).toBeGreaterThan(0);
    for (const init of inits) {
      expect(init?.redirect).toBe('manual');
    }
  });

  it('302 numa leitura conta como sessão expirada e dispara re-login (antes só o 403 disparava)', async () => {
    let loginPosts = 0;
    let dataCalls = 0;
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/users/admin/login/')) {
        if (init?.method === 'POST') {
          loginPosts += 1;
          return loginOkResponse();
        }
        return loginPageResponse();
      }
      dataCalls += 1;
      if (dataCalls === 1) {
        return new Response('', { status: 302, headers: { location: '/users/admin/login/' } });
      }
      return jsonResponse({ count: 0, next: null, results: [] });
    });

    const { now, sleep } = makeVirtualClock();
    const client = new AnaCareSessionClient({
      baseUrl: 'https://admin.ana.care',
      username: 'user@enlite.health',
      password: 'secret',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      rateLimiter: new AnaCareRateLimiter({ minIntervalMs: 0, now, sleep }),
    });

    await client.listShifts({ from: '2026-09-01', to: '2026-09-30' });

    expect(loginPosts).toBe(2);
  });
});

/**
 * Regressão do 500 medido em produção 17/09/2026 (4ª rodada do sync, cursor 168): a fonte
 * devolveu `nurse: null` num turno (15/3.421 medidos, 0,4%) e `minimizeShiftDTO` lia
 * `raw.nurse.id` sem checar — `TypeError: Cannot read properties of null (reading 'id')`.
 * Estes testes provam que `listShifts` agora DESCARTA e CONTA, nunca lança.
 */
describe('AnaCareSessionClient — turno sem prestador/paciente é descartado e CONTADO (conserto 17/09)', () => {
  function shiftsPage(results: unknown[]) {
    return jsonResponse({ count: results.length, next: null, previous: null, results });
  }

  it('turno com nurse:null NÃO entra no lote e é contado em skipped.noProvider — turno completo do mesmo lote continua passando', async () => {
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/users/admin/login/') && (!init?.method || init.method === 'GET')) return loginPageResponse();
      if (url.endsWith('/users/admin/login/') && init?.method === 'POST') return loginOkResponse();
      if (url.includes('/api/shifts/')) {
        return shiftsPage([
          {
            id: 1,
            start: '2026-09-01T13:00:00-06:00',
            end: '2026-09-01T17:00:00-06:00',
            checkin: null,
            checkout: null,
            checkin_source: null,
            checkout_source: null,
            checkin_delay: null,
            duration: null,
            month: '2026-09',
            is_finalized: false,
            patient: { id: 10, agency: 116, document_type: 'DNI', document_number: '1', first_name: 'A', last_name: 'B' },
            nurse: null, // turno agendado sem prestador designado — o defeito medido em produção
          },
          {
            id: 2,
            start: '2026-09-01T13:00:00-06:00',
            end: '2026-09-01T17:00:00-06:00',
            checkin: null,
            checkout: null,
            checkin_source: null,
            checkout_source: null,
            checkin_delay: null,
            duration: null,
            month: '2026-09',
            is_finalized: false,
            patient: { id: 11, agency: 116, document_type: 'DNI', document_number: '2', first_name: 'C', last_name: 'D' },
            nurse: { id: 101, agency: 116, first_name: 'N2', last_name: 'M2' },
          },
        ]);
      }
      throw new Error(`unexpected call: ${url}`);
    });

    const { now, sleep } = makeVirtualClock();
    const client = new AnaCareSessionClient({
      baseUrl: 'https://admin.ana.care',
      username: 'u',
      password: 'p',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      rateLimiter: new AnaCareRateLimiter({ minIntervalMs: 0, now, sleep }),
    });

    const result = await client.listShifts({ from: '2026-09-01', to: '2026-09-30' });

    // MORRE se alguém voltar a descartar sem contar: só o turno 2 (completo) sobrevive, e o
    // descarte do turno 1 aparece em `skipped.noProvider`, nunca só um array menor sem explicação.
    expect(result.shifts).toHaveLength(1);
    expect(result.shifts[0].anaCarePatientId).toBe('11');
    expect(result.skipped).toEqual({ noProvider: 1, noPatient: 0 });
  });

  it('turno com patient:null NÃO entra no lote e é contado em skipped.noPatient, separado de noProvider', async () => {
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/users/admin/login/') && (!init?.method || init.method === 'GET')) return loginPageResponse();
      if (url.endsWith('/users/admin/login/') && init?.method === 'POST') return loginOkResponse();
      if (url.includes('/api/shifts/')) {
        return shiftsPage([
          {
            id: 3,
            start: '2026-09-01T13:00:00-06:00',
            end: '2026-09-01T17:00:00-06:00',
            checkin: null,
            checkout: null,
            checkin_source: null,
            checkout_source: null,
            checkin_delay: null,
            duration: null,
            month: '2026-09',
            is_finalized: false,
            // universo D340 2ª perna: patient nulo + nurse.agency===116 — entra no filtro de
            // universo, mas não pode ser MINIMIZADO sem paciente.
            patient: null,
            nurse: { id: 300, agency: 116, first_name: 'N3', last_name: 'M3' },
          },
        ]);
      }
      throw new Error(`unexpected call: ${url}`);
    });

    const { now, sleep } = makeVirtualClock();
    const client = new AnaCareSessionClient({
      baseUrl: 'https://admin.ana.care',
      username: 'u',
      password: 'p',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      rateLimiter: new AnaCareRateLimiter({ minIntervalMs: 0, now, sleep }),
    });

    const result = await client.listShifts({ from: '2026-09-01', to: '2026-09-30' });

    expect(result.shifts).toHaveLength(0);
    expect(result.skipped).toEqual({ noProvider: 0, noPatient: 1 });
  });

  it('sem nenhum turno descartado no lote: skipped fica {0,0} e NENHUM log é emitido (contagem zero de verdade, não silêncio)', async () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined as unknown as ReturnType<typeof logger.warn>);
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/users/admin/login/') && (!init?.method || init.method === 'GET')) return loginPageResponse();
      if (url.endsWith('/users/admin/login/') && init?.method === 'POST') return loginOkResponse();
      if (url.includes('/api/shifts/')) {
        return shiftsPage([
          {
            id: 4,
            start: '2026-09-01T13:00:00-06:00',
            end: '2026-09-01T17:00:00-06:00',
            checkin: null,
            checkout: null,
            checkin_source: null,
            checkout_source: null,
            checkin_delay: null,
            duration: null,
            month: '2026-09',
            is_finalized: false,
            patient: { id: 40, agency: 116, document_type: 'DNI', document_number: '4', first_name: 'E', last_name: 'F' },
            nurse: { id: 400, agency: 116, first_name: 'N4', last_name: 'M4' },
          },
        ]);
      }
      throw new Error(`unexpected call: ${url}`);
    });

    const { now, sleep } = makeVirtualClock();
    const client = new AnaCareSessionClient({
      baseUrl: 'https://admin.ana.care',
      username: 'u',
      password: 'p',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      rateLimiter: new AnaCareRateLimiter({ minIntervalMs: 0, now, sleep }),
    });

    const result = await client.listShifts({ from: '2026-09-01', to: '2026-09-30' });

    expect(result.skipped).toEqual({ noProvider: 0, noPatient: 0 });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
