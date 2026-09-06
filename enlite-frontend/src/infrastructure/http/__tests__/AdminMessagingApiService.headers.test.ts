import { describe, it, expect, vi, beforeEach } from 'vitest';

// getIdToken retorna null (sem sessão/expirado) — cobre o ramo em que o header
// Authorization NÃO é adicionado (o spread condicional em getAuthHeaders).
vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({ getIdToken: vi.fn().mockResolvedValue(null) })),
}));

import { AdminMessagingApiService } from '../AdminMessagingApiService';

function mockFetch(status: number, json: unknown) {
  const fn = vi.fn().mockResolvedValue({ status, json: async () => json });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('AdminMessagingApiService — sem token (getIdToken retorna null)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('não manda o header Authorization quando não há token', async () => {
    const f = mockFetch(200, { success: true, data: { templateSlug: 'x', externalId: 'e', status: 'queued', to: '+54' } });

    await AdminMessagingApiService.sendVacancyMatchInvite('w-1', 'job-1');

    const headers = (f.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers).not.toHaveProperty('Authorization');
    expect(headers['Content-Type']).toBe('application/json');
  });
});
