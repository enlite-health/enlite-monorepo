/**
 * AdminPresenceApiService — POST /api/admin/me/presence (heartbeat, spec 022, Rodada 2/R2-F).
 * Molde: `AdminNotificationApiService.ts` — mesmo `getAuthHeaders`. Diferença: a rota devolve
 * 204 SEM corpo no sucesso (nunca `{success,data}`) — não pode reusar `requestJson` (que sempre
 * tenta `response.json()`, e um corpo vazio quebraria o parse).
 *
 * `vi.unstubAllGlobals()` no `afterEach`: mesmo padrão de `AdminConversationApiService.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let token: string | null = 'tok';
vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({ getIdToken: vi.fn(async () => token) })),
}));

import { AdminPresenceApiService } from '../AdminPresenceApiService';
import { ApiError } from '../ApiError';

describe('AdminPresenceApiService', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    token = 'tok';
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('heartbeat: POST /api/admin/me/presence com Authorization, resolve sem valor no 204', async () => {
    fetchMock.mockResolvedValue({ status: 204, ok: true, json: async () => { throw new Error('no body'); } });

    await expect(AdminPresenceApiService.heartbeat()).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/admin/me/presence');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok');
  });

  it('heartbeat: 401 (sem sessão) rejeita com ApiError(401)', async () => {
    fetchMock.mockResolvedValue({
      status: 401,
      ok: false,
      json: async () => ({ success: false, error: 'Not authenticated', code: 'MISSING_ACTOR' }),
    });
    await expect(AdminPresenceApiService.heartbeat()).rejects.toBeInstanceOf(ApiError);
    await expect(AdminPresenceApiService.heartbeat()).rejects.toMatchObject({ status: 401 });
  });

  it('heartbeat: 403 (sem célula own_presence:update) rejeita com ApiError(403)', async () => {
    fetchMock.mockResolvedValue({
      status: 403,
      ok: false,
      json: async () => ({ success: false, error: 'Forbidden' }),
    });
    await expect(AdminPresenceApiService.heartbeat()).rejects.toMatchObject({ status: 403 });
  });

  it('sem token: manda a chamada sem header Authorization (mesmo padrão dos outros clients)', async () => {
    token = null;
    fetchMock.mockResolvedValue({ status: 204, ok: true, json: async () => { throw new Error('no body'); } });
    await AdminPresenceApiService.heartbeat();
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBeUndefined();
  });
});
