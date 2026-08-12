import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AdminApiService, ApiError } from '../AdminApiService';

vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({
    getIdToken: vi.fn().mockResolvedValue('mock-token'),
  })),
}));

const PROFILE = { firebaseUid: 'uid-1', email: 'florencia.uberti@enlite.health', role: 'recruiter' };

/** A JSON success response (200). */
function okResponse(data: unknown) {
  return { status: 200, json: () => Promise.resolve({ success: true, data }) } as unknown as Response;
}

/** A structured backend error (e.g. 404 "Admin user not found"). */
function apiErrorResponse(status: number, error: string) {
  return { status, json: () => Promise.resolve({ success: false, error }) } as unknown as Response;
}

/** A cold-start / proxy 503 that returns non-JSON HTML → response.json() throws. */
function coldStartResponse() {
  return { status: 503, json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')) } as unknown as Response;
}

describe('AdminApiService.getProfile — cold-start resilience', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.useRealTimers(); });

  it('retenta e resolve quando a 1ª tentativa falha por cold start (503 não-JSON)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(coldStartResponse())
      .mockResolvedValueOnce(okResponse(PROFILE));

    vi.useFakeTimers();
    const promise = AdminApiService.getProfile();
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual(PROFILE);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('retenta quando o fetch rejeita por erro de rede', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(okResponse(PROFILE));

    vi.useFakeTimers();
    const promise = AdminApiService.getProfile();
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual(PROFILE);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('NÃO retenta quando o backend responde 404 (não é admin) — falha definitiva', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(apiErrorResponse(404, 'Admin user not found'));

    await expect(AdminApiService.getProfile()).rejects.toBeInstanceOf(ApiError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('NÃO retenta quando o backend responde 401 (sem auth) — falha definitiva', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(apiErrorResponse(401, 'Authentication required'));

    await expect(AdminApiService.getProfile()).rejects.toBeInstanceOf(ApiError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('desiste após esgotar as tentativas e propaga o erro transiente', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new TypeError('Failed to fetch'));

    vi.useFakeTimers();
    const promise = AdminApiService.getProfile();
    // Evita unhandled rejection enquanto os timers correm.
    const settled = promise.catch((e) => e);
    await vi.runAllTimersAsync();
    await settled;

    await expect(promise).rejects.toBeInstanceOf(TypeError);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});
