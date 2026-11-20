/**
 * AdminDailyReportsApiService — spec 092 (T501): GET com Authorization, corpo `{ items }` direto (sem envelope `success/data`),
 * e erro com status (403 vira `DailyReportsApiError.status`, que a aba usa para "sem acesso").
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let token: string | null = 'tok';
vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({ getIdToken: vi.fn(async () => token) })),
}));

import { AdminDailyReportsApiService, DailyReportsApiError } from '../AdminDailyReportsApiService';

const res = (body: unknown, status = 200, ok = status < 400): Response => ({ status, ok, json: async () => body } as unknown as Response);

describe('AdminDailyReportsApiService', () => {
  const fetchMock = vi.fn();
  beforeEach(() => { token = 'tok'; fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('listForPatient: GET na rota do paciente, com Authorization, devolve { items }', async () => {
    fetchMock.mockResolvedValue(res({ items: [{ id: 'r1' }] }));
    expect(await AdminDailyReportsApiService.listForPatient('p1')).toEqual({ items: [{ id: 'r1' }] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/admin/patients/p1/daily-reports');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer tok');
  });

  it('sem token: sai sem Authorization (o servidor responde 401)', async () => {
    token = null;
    fetchMock.mockResolvedValue(res({ items: [] }));
    await AdminDailyReportsApiService.listForPatient('p1');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it('403: DailyReportsApiError com status 403 e a mensagem do corpo', async () => {
    fetchMock.mockResolvedValue(res({ success: false, error: 'forbidden' }, 403));
    const err = await AdminDailyReportsApiService.listForPatient('p1').catch((e) => e);
    expect(err).toBeInstanceOf(DailyReportsApiError);
    expect(err).toMatchObject({ status: 403, message: 'forbidden' });
  });

  it('corpo ilegível ou sem items: erro com HTTP <status>', async () => {
    fetchMock.mockResolvedValueOnce({ status: 502, ok: false, json: async () => { throw new Error('html'); } } as unknown as Response);
    await expect(AdminDailyReportsApiService.listForPatient('p1')).rejects.toMatchObject({ status: 502, message: 'HTTP 502' });
    fetchMock.mockResolvedValueOnce(res({ qualquer: 1 }, 200));
    await expect(AdminDailyReportsApiService.listForPatient('p1')).rejects.toMatchObject({ status: 200, message: 'HTTP 200' });
  });
});
