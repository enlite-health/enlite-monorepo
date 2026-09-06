/**
 * AdminFunnelStageMessagesApiService.test.ts — os dois métodos da config por etapa (DEC-12):
 * rota, verbo e o corpo em snake_case que o backend valida (strict).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdminFunnelStageMessagesApiService } from '../AdminFunnelStageMessagesApiService';

const mockGetIdToken = vi.fn().mockResolvedValue('mock-token');
vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({ getIdToken: (...a: unknown[]) => mockGetIdToken(...a) })),
}));

function mockFetch(data: unknown) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true, status: 200,
    json: () => Promise.resolve({ success: true, data }),
    headers: { get: () => 'application/json' },
  }) as unknown as typeof fetch;
  return global.fetch as unknown as ReturnType<typeof vi.fn>;
}

describe('AdminFunnelStageMessagesApiService', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('getFunnelStageMessages → GET /api/admin/funnel-stage-messages', async () => {
    const cfg = { country: 'AR', stages: [], templates: [] };
    const f = mockFetch(cfg);
    const r = await AdminFunnelStageMessagesApiService.getFunnelStageMessages();
    expect(r).toEqual(cfg);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/admin/funnel-stage-messages');
    expect(init.method).toBe('GET');
  });

  it('updateFunnelStageMessage → PUT /:stage com template_slug/enabled (snake_case, null desliga)', async () => {
    const f = mockFetch({ stage: 'COMPLETED', templateSlug: null, enabled: false });
    const r = await AdminFunnelStageMessagesApiService.updateFunnelStageMessage('COMPLETED', { templateSlug: null, enabled: false });
    expect(r).toEqual({ stage: 'COMPLETED', templateSlug: null, enabled: false });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/admin/funnel-stage-messages/COMPLETED');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ template_slug: null, enabled: false });
  });

  it('com token → Authorization: Bearer; sem token (sessão caída) → sem o header, e o backend é quem nega', async () => {
    const f = mockFetch({ country: 'AR', stages: [], templates: [] });
    await AdminFunnelStageMessagesApiService.getFunnelStageMessages();
    expect((f.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer mock-token' });
    mockGetIdToken.mockResolvedValueOnce(null);
    const f2 = mockFetch({ country: 'AR', stages: [], templates: [] });
    await AdminFunnelStageMessagesApiService.getFunnelStageMessages();
    expect((f2.mock.calls[0][1] as RequestInit).headers).not.toHaveProperty('Authorization');
  });

  it('resposta success=false → lança Error com a mensagem do backend', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 409, json: () => Promise.resolve({ success: false, error: 'Built-in stage' }) }) as unknown as typeof fetch;
    await expect(AdminFunnelStageMessagesApiService.updateFunnelStageMessage('QUALIFIED', { templateSlug: 'x', enabled: true })).rejects.toThrow('Built-in stage');
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({ success: false }) }) as unknown as typeof fetch;
    await expect(AdminFunnelStageMessagesApiService.getFunnelStageMessages()).rejects.toThrow('HTTP 500');
  });
});
