/**
 * AdminNotificationApiService — spec 022, Bloco 4 (T409). Espelha
 * `contracts/openapi-notifications.md` (4 rotas sob `/api/admin/notifications`). Molde:
 * `AdminConversationApiService.test.ts` — mesmo `fetch` stubado globalmente,
 * `vi.unstubAllGlobals()` no `afterEach` (sem isso o stub vaza pro `describe` seguinte).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let token: string | null = 'tok';
vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({ getIdToken: vi.fn(async () => token) })),
}));

import { AdminNotificationApiService } from '../AdminNotificationApiService';
import { ApiError } from '../ApiError';

const json = (body: unknown, status = 200): Response => ({ status, json: async () => body } as unknown as Response);

describe('AdminNotificationApiService', () => {
  const fetchMock = vi.fn();
  beforeEach(() => { token = 'tok'; fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('listNotifications: GET sem query quando sem params', async () => {
    fetchMock.mockResolvedValue(json({ success: true, data: [] }));
    const result = await AdminNotificationApiService.listNotifications();
    expect(result).toEqual([]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/admin/notifications');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer tok');
  });

  it('listNotifications: unreadOnly=true vira ?unread=1; limit vira query', async () => {
    fetchMock.mockResolvedValue(json({ success: true, data: [] }));
    await AdminNotificationApiService.listNotifications({ unreadOnly: true, limit: 10 });
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/admin/notifications?unread=1&limit=10');
  });

  it('getUnreadCount: devolve o count desembrulhado', async () => {
    fetchMock.mockResolvedValue(json({ success: true, data: { count: 4 } }));
    const count = await AdminNotificationApiService.getUnreadCount();
    expect(count).toBe(4);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/admin/notifications/unread-count');
    expect(init.method).toBe('GET');
  });

  it('markNotificationRead: POST para :id/read, resolve void', async () => {
    fetchMock.mockResolvedValue(json({ success: true }));
    await expect(AdminNotificationApiService.markNotificationRead('n1')).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/admin/notifications/n1/read');
    expect(init.method).toBe('POST');
  });

  it('markAllNotificationsRead: POST read-all, devolve updated desembrulhado', async () => {
    fetchMock.mockResolvedValue(json({ success: true, data: { updated: 3 } }));
    const updated = await AdminNotificationApiService.markAllNotificationsRead();
    expect(updated).toBe(3);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/admin/notifications/read-all');
    expect(init.method).toBe('POST');
  });

  it('resposta success:false lança ApiError com o status HTTP', async () => {
    fetchMock.mockResolvedValue(json({ success: false, error: 'nope', code: 'NOTIFICATION_NOT_FOUND' }, 404));
    await expect(AdminNotificationApiService.markNotificationRead('n1')).rejects.toBeInstanceOf(ApiError);
  });

  it('sem token (não autenticado): requisição sai sem header Authorization', async () => {
    token = null;
    fetchMock.mockResolvedValue(json({ success: true, data: { count: 0 } }));
    await AdminNotificationApiService.getUnreadCount();
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBeUndefined();
  });
});
