/**
 * Spec 036 CA-2 — contrato com o servidor. `AnaCareSessionClient` REAL + `fetchImpl` falso que
 * IMPLEMENTA a semântica medida do Ana Care: `min_date <= data_local_do_início < max_date` (fim
 * EXCLUSIVO). Sem mockar o comportamento sob teste (a tradução mês → janela).
 *
 * Helpers de login/clock replicados do `AnaCareSessionClient.test.ts` (não exportados lá; extrair
 * para helper compartilhado exigiria tocar teste existente, fora do escopo desta fase).
 */
import { AnaCareSessionClient } from '../AnaCareSessionClient';
import { AnaCareRateLimiter } from '../AnaCareRateLimiter';
import { AnaCareShiftsSourceReal } from '../AnaCareShiftsSourceReal';

function makeVirtualClock() {
  let time = 0;
  const now = () => time;
  const sleep = (ms: number) => new Promise<void>((resolve) => { time += ms; resolve(); });
  return { now, sleep };
}
const loginPageResponse = () =>
  new Response('<html>login form</html>', { status: 200, headers: { 'set-cookie': 'csrftoken=csrf-abc123; Path=/' } });
const loginOkResponse = () =>
  new Response('redirect', {
    status: 302,
    headers: { 'set-cookie': 'sessionid=session-xyz789; Path=/', location: '/admin/accounts/' },
  });
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function rawShift(id: number, start: string, end: string = start) {
  return {
    id,
    start,
    end,
    checkin: null,
    checkout: null,
    checkin_source: null,
    checkout_source: null,
    checkin_delay: null,
    duration: null,
    month: start.slice(0, 7),
    is_finalized: false,
    patient: { id: 10, agency: 116, identification_type: 'DNI', identification_number: '1', first_name: 'A', last_name: 'B' },
    nurse: { id: 100, first_name: 'N', last_name: 'M' },
  };
}

/**
 * Dia LOCAL do início previsto (primeiros 10 chars do ISO com offset `-06:00`). Semântica MEDIDA em
 * 01/10/2026: o servidor compara `min_date <= dia_local(start) < max_date`; um turno que começa
 * 30/09 22:00 -06:00 cai em setembro, embora seja 01/10 04:00 UTC.
 */
const serverShiftDate = (start: string) => start.slice(0, 10);

const SERVER_SHIFTS = [
  rawShift(1, '2026-08-31T08:00:00-06:00'),
  rawShift(2, '2026-09-30T08:00:00-06:00'),
  rawShift(3, '2026-10-01T08:00:00-06:00'),
  rawShift(4, '2026-09-30T22:00:00-06:00', '2026-10-01T10:00:00-06:00'), // noturno: começa 30/09 local, termina 01/10
];

describe('AnaCareShiftsSourceReal × servidor com max_date EXCLUSIVO (Spec 036 CA-2)', () => {
  it('mês 2026-09 inclui o turno de 30/09 e exclui 31/08 e 01/10', async () => {
    const shiftCalls: string[] = [];
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/users/admin/login/') && (!init?.method || init.method === 'GET')) return loginPageResponse();
      if (url.endsWith('/users/admin/login/') && init?.method === 'POST') return loginOkResponse();
      if (url.includes('/api/shifts/')) {
        shiftCalls.push(url);
        const q = new URL(url).searchParams;
        const min = q.get('min_date') as string;
        const max = q.get('max_date') as string;
        const results = SERVER_SHIFTS.filter((s) => min <= serverShiftDate(s.start) && serverShiftDate(s.start) < max);
        return jsonResponse({ count: results.length, next: null, previous: null, results });
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

    const { shifts } = await new AnaCareShiftsSourceReal(client).listShifts({ month: '2026-09' });

    expect(shiftCalls.length).toBeGreaterThanOrEqual(1); // contagem zero = teste morto
    const ids = shifts.map((s) => s.sourceShiftId);
    expect(ids).toContain('2'); // 30/09
    expect(ids).toContain('4'); // noturno 30/09 22:00 -06:00 vem em setembro
    expect(ids).not.toContain('3'); // 01/10
    expect(ids).not.toContain('1'); // 31/08
  });
});
