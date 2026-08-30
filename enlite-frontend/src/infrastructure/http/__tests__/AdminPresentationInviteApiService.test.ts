/**
 * AdminPresentationInviteApiService.test.ts — rotas, verbos e o corpo snake_case (zod strict no backend).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdminPresentationInviteApiService } from '../AdminPresentationInviteApiService';

const { getIdToken } = vi.hoisted(() => ({ getIdToken: vi.fn() }));
vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({ getIdToken })),
}));

function mockFetch(data: unknown, ok = true, status = 200) {
  global.fetch = vi.fn().mockResolvedValue({ ok, status, json: () => Promise.resolve(ok ? { success: true, data } : { success: false, error: typeof data === 'string' ? data : undefined }) }) as unknown as typeof fetch;
  return global.fetch as unknown as ReturnType<typeof vi.fn>;
}
const call = (f: ReturnType<typeof vi.fn>) => f.mock.calls[0] as [string, RequestInit];

describe('AdminPresentationInviteApiService', () => {
  beforeEach(() => { vi.clearAllMocks(); getIdToken.mockResolvedValue('mock-token'); });

  it('com token manda Authorization; sem token (sessão caída) não manda o header — e o backend responde 401 visível', async () => {
    const f = mockFetch({ country: 'AR' });
    await AdminPresentationInviteApiService.getSettings();
    expect((call(f)[1].headers as Record<string, string>).Authorization).toBe('Bearer mock-token');
    getIdToken.mockResolvedValue(null);
    const g = mockFetch('Unauthenticated', false, 401);
    await expect(AdminPresentationInviteApiService.getSettings()).rejects.toThrow('Unauthenticated');
    expect((call(g)[1].headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('getSettings → GET /settings; stats → GET /stats', async () => {
    const f = mockFetch({ country: 'AR' });
    expect(await AdminPresentationInviteApiService.getSettings()).toEqual({ country: 'AR' });
    expect(call(f)[0]).toContain('/api/admin/presentation-invite/settings'); expect(call(f)[1].method).toBe('GET');
    const g = mockFetch({ windowDays: 30, rows: [], attended: 0 });
    expect((await AdminPresentationInviteApiService.stats()).windowDays).toBe(30);
    expect(call(g)[0]).toContain('/api/admin/presentation-invite/stats');
  });

  it('updateSettings → PUT com snake_case', async () => {
    const f = mockFetch({ enabled: true });
    await AdminPresentationInviteApiService.updateSettings({ templateSlug: 'x', meetLink: 'https://meet.google.com/abc-defg-hij', scheduleLabel: null, enabled: true });
    expect(call(f)[1].method).toBe('PUT');
    expect(JSON.parse(String(call(f)[1].body))).toEqual({ template_slug: 'x', meet_link: 'https://meet.google.com/abc-defg-hij', schedule_label: null, enabled: true });
  });

  it('invite → POST /workers/:id/presentation-invite com origem e vaga (null quando ausente)', async () => {
    const f = mockFetch({ status: 'queued', outboxId: 'o1' });
    expect(await AdminPresentationInviteApiService.invite('w1', 'kanban', 'j1')).toEqual({ status: 'queued', outboxId: 'o1' });
    expect(call(f)[0]).toContain('/api/admin/workers/w1/presentation-invite');
    expect(JSON.parse(String(call(f)[1].body))).toEqual({ source: 'kanban', job_posting_id: 'j1' });
    const g = mockFetch({ status: 'skipped', skipReason: 'OPT_OUT' });
    await AdminPresentationInviteApiService.invite('w2', 'workers_list');
    expect(JSON.parse(String(call(g)[1].body))).toEqual({ source: 'workers_list', job_posting_id: null });
  });

  it('last → GET com ids codificados; lista vazia não chama a rede', async () => {
    const f = mockFetch({ w1: { at: 'd', by: null } });
    expect(await AdminPresentationInviteApiService.last(['w1', 'w2'])).toEqual({ w1: { at: 'd', by: null } });
    expect(call(f)[0]).toContain('workerIds=w1%2Cw2');
    const g = mockFetch({});
    expect(await AdminPresentationInviteApiService.last([])).toEqual({});
    expect(g).not.toHaveBeenCalled();
  });

  it('success=false → Error com a mensagem do backend ou HTTP <status>', async () => {
    mockFetch('Template not eligible', false, 400);
    await expect(AdminPresentationInviteApiService.getSettings()).rejects.toThrow('Template not eligible');
    mockFetch(undefined, false, 500);
    await expect(AdminPresentationInviteApiService.stats()).rejects.toThrow('HTTP 500');
  });
});
