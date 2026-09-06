import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({ getIdToken: vi.fn().mockResolvedValue('tok') })),
}));

import { AdminMessagingApiService, InviteBlockedError } from '../AdminMessagingApiService';

function mockFetch(status: number, json: unknown) {
  const fn = vi.fn().mockResolvedValue({ status, json: async () => json });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('AdminMessagingApiService.sendVacancyMatchInvite — resend (REQ-08)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('convite normal NÃO manda `resend` no corpo', async () => {
    const f = mockFetch(200, { success: true, data: { templateSlug: 'x', externalId: 'e', status: 'queued', to: '+54' } });
    await AdminMessagingApiService.sendVacancyMatchInvite('w-1', 'job-1');
    const body = JSON.parse((f.mock.calls[0][1] as { body: string }).body);
    expect(body).toEqual({ workerId: 'w-1', jobPostingId: 'job-1' });
    expect((f.mock.calls[0][1] as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer tok');
  });

  it('reenvio manda `resend: true` e devolve o resultado', async () => {
    const f = mockFetch(200, { success: true, data: { templateSlug: 'x', externalId: 'e', status: 'queued', to: '+54' } });
    const out = await AdminMessagingApiService.sendVacancyMatchInvite('w-1', 'job-1', { resend: true });
    expect(JSON.parse((f.mock.calls[0][1] as { body: string }).body)).toEqual({ workerId: 'w-1', jobPostingId: 'job-1', resend: true });
    expect(out.externalId).toBe('e');
  });

  it('422 vira InviteBlockedError com o código (RESEND_COOLDOWN)', async () => {
    mockFetch(422, { error: 'RESEND_COOLDOWN', detail: 'janela' });
    await expect(AdminMessagingApiService.sendVacancyMatchInvite('w-1', 'job-1', { resend: true })).rejects.toBeInstanceOf(InviteBlockedError);
  });

  it('erro não-422 vira Error com a mensagem do backend (ou HTTP <status>)', async () => {
    mockFetch(502, { success: false, error: 'Periskope error' });
    await expect(AdminMessagingApiService.sendVacancyMatchInvite('w-1', 'job-1')).rejects.toThrow('Periskope error');
    mockFetch(500, { success: false });
    await expect(AdminMessagingApiService.sendVacancyMatchInvite('w-1', 'job-1')).rejects.toThrow('HTTP 500');
  });

  it('422 sem `detail` no corpo: a mensagem do InviteBlockedError cai para o code', async () => {
    mockFetch(422, { error: 'OPTED_OUT' });
    await expect(AdminMessagingApiService.sendVacancyMatchInvite('w-1', 'job-1')).rejects.toThrow('OPTED_OUT');
  });

  it('InviteBlockedError sem detail usa o code como mensagem (super(detail || code))', () => {
    const err = new InviteBlockedError('WORKER_STATUS_INVALID');
    expect(err.message).toBe('WORKER_STATUS_INVALID');
    expect(err.detail).toBeUndefined();
  });
});
