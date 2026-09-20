/**
 * AdminPatientPhotoApiService — spec 018, PR-4. Cobre os 3 métodos de foto, sucesso e erro
 * (`ApiError`), multipart vs JSON, token ausente. Documento/consentimento foi removido
 * (fix/018-remover-documentos-consentimento).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let token: string | null = 'tok';
vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({ getIdToken: vi.fn(async () => token) })),
}));

import { AdminPatientPhotoApiService } from '../AdminPatientPhotoApiService';
import { ApiError } from '../ApiError';

const json = (body: unknown, status = 200): Response =>
  ({ status, json: async () => body } as unknown as Response);

describe('AdminPatientPhotoApiService', () => {
  const fetchMock = vi.fn();
  beforeEach(() => { token = 'tok'; fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });

  it('uploadPatientPhoto: manda multipart (sem Content-Type manual) com Authorization', async () => {
    fetchMock.mockResolvedValue(json({ success: true, data: { hasPhoto: true } }));
    const file = new File(['x'], 'foto.jpg', { type: 'image/jpeg' });
    await expect(AdminPatientPhotoApiService.uploadPatientPhoto('p1', file)).resolves.toEqual({ hasPhoto: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/admin\/patients\/p1\/photo$/);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(init.headers['Content-Type']).toBeUndefined();
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('deletePatientPhoto: DELETE 204 SEM corpo (contrato) — nunca tenta parsear JSON vazio', async () => {
    fetchMock.mockResolvedValue({ status: 204, json: async () => { throw new Error('não deveria chamar .json() num 204'); } });
    await expect(AdminPatientPhotoApiService.deletePatientPhoto('p1')).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/photo$/);
    expect(init.method).toBe('DELETE');
  });

  it('getPatientPhotoUrl: GET, devolve {url, expiresInSeconds}', async () => {
    fetchMock.mockResolvedValue(json({ success: true, data: { url: 'https://x', expiresInSeconds: 300 } }));
    await expect(AdminPatientPhotoApiService.getPatientPhotoUrl('p1')).resolves.toEqual({ url: 'https://x', expiresInSeconds: 300 });
    expect(fetchMock.mock.calls[0][1].method).toBe('GET');
  });

  it('erro (success:false) em rota JSON: lança ApiError com code/status', async () => {
    fetchMock.mockResolvedValue(json({ success: false, error: 'Sem foto', code: 'NOT_FOUND' }, 404));
    await expect(AdminPatientPhotoApiService.getPatientPhotoUrl('p1')).rejects.toMatchObject({ message: 'Sem foto', code: 'NOT_FOUND', status: 404 });
    await expect(AdminPatientPhotoApiService.getPatientPhotoUrl('p1')).rejects.toBeInstanceOf(ApiError);
  });

  it('sem token: nenhuma chamada manda Authorization', async () => {
    token = null;
    fetchMock.mockResolvedValue(json({ success: true, data: { url: 'x', expiresInSeconds: 1 } }));
    await AdminPatientPhotoApiService.getPatientPhotoUrl('p1');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });
});
