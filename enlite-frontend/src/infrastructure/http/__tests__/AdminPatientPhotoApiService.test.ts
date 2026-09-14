/**
 * AdminPatientPhotoApiService — spec 018, PR-4. Cobre os 7 métodos (foto, documento,
 * consentimento), sucesso e erro (`ApiError`), multipart vs JSON, token ausente.
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

  it('uploadPatientDocument: multipart com file + documentType', async () => {
    fetchMock.mockResolvedValue(json({ success: true, data: { documentId: 'd1' } }));
    const file = new File(['x'], 'doc.pdf', { type: 'application/pdf' });
    await expect(AdminPatientPhotoApiService.uploadPatientDocument('p1', file, 'image_consent')).resolves.toEqual({ documentId: 'd1' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/patients\/p1\/documents$/);
    const form = init.body as FormData;
    expect(form.get('documentType')).toBe('image_consent');
  });

  it('erro em rota multipart: também lança ApiError', async () => {
    fetchMock.mockResolvedValue(json({ success: false, error: '413' }, 413));
    const file = new File(['x'], 'doc.pdf', { type: 'application/pdf' });
    await expect(AdminPatientPhotoApiService.uploadPatientDocument('p1', file, 'image_consent')).rejects.toBeInstanceOf(ApiError);
  });

  it('getPatientDocumentUrl: GET por documentId', async () => {
    fetchMock.mockResolvedValue(json({ success: true, data: { url: 'https://x', expiresInSeconds: 300 } }));
    await AdminPatientPhotoApiService.getPatientDocumentUrl('p1', 'd1');
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/patients\/p1\/documents\/d1$/);
  });

  it('registerImageConsent: POST com o payload completo', async () => {
    fetchMock.mockResolvedValue(json({ success: true, data: { id: 'c1' } }));
    const payload = { consenterKind: 'PATIENT' as const, textVersion: 'v1', consentedAt: '2026-09-14T00:00:00.000Z' };
    await expect(AdminPatientPhotoApiService.registerImageConsent('p1', payload)).resolves.toEqual({ id: 'c1' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/image-consents$/);
    expect(JSON.parse(init.body)).toEqual(payload);
  });

  it('revokeImageConsent: POST para /revoke', async () => {
    fetchMock.mockResolvedValue(json({ success: true, data: {} }));
    await AdminPatientPhotoApiService.revokeImageConsent('p1', 'c1', { revocationChannel: 'WRITTEN' });
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/image-consents\/c1\/revoke$/);
  });

  it('sem token: nenhuma chamada manda Authorization', async () => {
    token = null;
    fetchMock.mockResolvedValue(json({ success: true, data: { url: 'x', expiresInSeconds: 1 } }));
    await AdminPatientPhotoApiService.getPatientPhotoUrl('p1');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });
});
