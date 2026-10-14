/**
 * AdminEnquadreApiService — spec 052: as 11 rotas de `adminEnquadreEventRoutes.ts` (verbo, URL, corpo), o desembrulho
 * do envelope `{success,data}` e o erro do servidor como `ApiError` com `code`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({ getIdToken: vi.fn(async () => 'tok') })),
}));

import { AdminEnquadreApiService as Api } from '../AdminEnquadreApiService';
import { ApiError } from '../ApiError';

const json = (body: unknown, status = 200): Response => ({ status, json: async () => body } as unknown as Response);
const V = '11111111-1111-4111-8111-111111111111';
const E = '22222222-2222-4222-8222-222222222222';
const P = '33333333-3333-4333-8333-333333333333';
const H = '44444444-4444-4444-8444-444444444444';
const ROOT = `http://localhost:8080/api/admin/vacancies/${V}/enquadre-events`;

describe('AdminEnquadreApiService', () => {
  const fetchMock = vi.fn();
  beforeEach(() => { fetchMock.mockReset(); fetchMock.mockResolvedValue(json({ success: true, data: { ok: 1 } })); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => { vi.unstubAllGlobals(); });

  const last = (): { url: string; method: string; body: unknown; auth: string } => {
    const [url, init] = fetchMock.mock.calls[0];
    return { url, method: init.method, body: init.body === undefined ? undefined : JSON.parse(init.body), auth: init.headers.Authorization };
  };

  const cases: Array<[string, () => Promise<unknown>, string, string, unknown]> = [
    ['listEvents', () => Api.listEvents(V), 'GET', ROOT, undefined],
    ['getEvent', () => Api.getEvent(V, E), 'GET', `${ROOT}/${E}`, undefined],
    ['listAvailableWorkers', () => Api.listAvailableWorkers(V), 'GET', `${ROOT}/available-workers`, undefined],
    ['listHosts', () => Api.listHosts(V), 'GET', `${ROOT}/hosts`, undefined],
    ['listHostFreeSlots', () => Api.listHostFreeSlots(V, H, '2026-10-20', 45), 'GET', `${ROOT}/hosts/${H}/free-slots?date=2026-10-20&durationMinutes=45`, undefined],
    [
      'createEvent',
      () => Api.createEvent(V, { hostId: H, startsAt: '2026-10-20T10:00', durationMinutes: 60, workerIds: [P] }),
      'POST', ROOT, { hostId: H, startsAt: '2026-10-20T10:00', durationMinutes: 60, workerIds: [P] },
    ],
    ['closeEvent', () => Api.closeEvent(V, E), 'POST', `${ROOT}/${E}/close`, undefined],
    ['cancelEvent', () => Api.cancelEvent(V, E), 'POST', `${ROOT}/${E}/cancel`, undefined],
    ['addParticipants', () => Api.addParticipants(V, E, [P]), 'POST', `${ROOT}/${E}/participants`, { workerIds: [P] }],
    ['removeParticipant', () => Api.removeParticipant(V, E, P), 'POST', `${ROOT}/${E}/participants/${P}/remove`, undefined],
    ['moveParticipant sem motivo', () => Api.moveParticipant(V, E, P, 'SELECTED'), 'PUT', `${ROOT}/${E}/participants/${P}/move`, { column: 'SELECTED' }],
    ['moveParticipant com motivo', () => Api.moveParticipant(V, E, P, 'REJECTED', 'NO_SHOW'), 'PUT', `${ROOT}/${E}/participants/${P}/move`, { column: 'REJECTED', reason: 'NO_SHOW' }],
  ];

  it.each(cases)('%s: verbo, URL e corpo, com Authorization, e devolve o `data` do envelope', async (_n, call, method, url, body) => {
    expect(await call()).toEqual({ ok: 1 });
    expect(last()).toEqual({ url, method, body, auth: 'Bearer tok' });
  });

  it('erro de domínio vira ApiError com code e status', async () => {
    fetchMock.mockResolvedValue(json({ success: false, error: 'texto do servidor', code: 'ENQUADRE_EVENT_NOT_OPEN' }, 409));
    const err = await Api.closeEvent(V, E).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('ENQUADRE_EVENT_NOT_OPEN');
    expect((err as ApiError).status).toBe(409);
  });
});
