/**
 * AdminPatientDocumentsApiService — spec 031: as 5 rotas de `patientDocumentsRoutes.ts`, o 204 sem
 * corpo do DELETE, multipart sem Content-Type manual e erro do servidor como `ApiError`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let token: string | null = 'tok';
vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({ getIdToken: vi.fn(async () => token) })),
}));

import { AdminPatientDocumentsApiService } from '../AdminPatientDocumentsApiService';
import { ApiError } from '../ApiError';

const json = (body: unknown, status = 200): Response => ({ status, json: async () => body } as unknown as Response);
const noBody = (status: number): Response => ({
  status,
  json: async () => { throw new Error('sem corpo'); },
} as unknown as Response);

const doc = {
  id: 'd1', origin: 'tab', label: 'DNI frente', contentType: 'application/pdf', sizeBytes: 10,
  createdAt: '2026-10-01T00:00:00.000Z', createdByUid: 'u', createdByDisplayName: null, labelUpdatedAt: null,
};

describe('AdminPatientDocumentsApiService', () => {
  const fetchMock = vi.fn();
  beforeEach(() => { token = 'tok'; fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('listPatientDocuments: GET com Authorization e devolve o array de data', async () => {
    fetchMock.mockResolvedValue(json({ success: true, data: [doc] }));
    expect(await AdminPatientDocumentsApiService.listPatientDocuments('p1')).toEqual([doc]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/admin/patients/p1/documents');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(init.body).toBeUndefined();
  });

  it('sem token: a chamada sai sem Authorization (o servidor responde 401)', async () => {
    token = null;
    fetchMock.mockResolvedValue(json({ success: true, data: [] }));
    await AdminPatientDocumentsApiService.listPatientDocuments('p1');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it('uploadPatientDocument: POST multipart com label e file, SEM Content-Type manual', async () => {
    fetchMock.mockResolvedValue(json({ success: true, data: doc }, 201));
    const file = new File(['x'], 'a.pdf', { type: 'application/pdf' });
    expect(await AdminPatientDocumentsApiService.uploadPatientDocument('p1', 'DNI frente', file)).toEqual(doc);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/admin/patients/p1/documents');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBeUndefined();
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.body.get('label')).toBe('DNI frente');
    expect(init.body.get('file')).toBe(file);
  });

  it('renamePatientDocument: PATCH {label} e devolve o documento atualizado', async () => {
    fetchMock.mockResolvedValue(json({ success: true, data: { ...doc, label: 'novo' } }));
    expect((await AdminPatientDocumentsApiService.renamePatientDocument('p1', 'd1', 'novo')).label).toBe('novo');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/admin/patients/p1/documents/d1');
    expect(init.method).toBe('PATCH');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ label: 'novo' });
  });

  it('deletePatientDocument: DELETE responde 204 SEM corpo e resolve void', async () => {
    fetchMock.mockResolvedValue(noBody(204));
    await expect(AdminPatientDocumentsApiService.deletePatientDocument('p1', 'd1')).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8080/api/admin/patients/p1/documents/d1');
    expect(init.method).toBe('DELETE');
  });

  it('getPatientDocumentUrl: GET .../url devolve url + validade', async () => {
    fetchMock.mockResolvedValue(json({ success: true, data: { url: 'https://signed/x', expiresInSeconds: 300 } }));
    expect(await AdminPatientDocumentsApiService.getPatientDocumentUrl('p1', 'd1')).toEqual({ url: 'https://signed/x', expiresInSeconds: 300 });
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8080/api/admin/patients/p1/documents/d1/url');
  });

  it.each([
    [413, 'FILE_TOO_LARGE'],
    [415, 'UNSUPPORTED_MEDIA_TYPE'],
    [404, 'DOCUMENT_NOT_FOUND'],
  ])('erro %i do servidor vira ApiError com status e code', async (status, code) => {
    fetchMock.mockResolvedValue(json({ success: false, error: 'x', code }, status));
    const file = new File(['x'], 'a.pdf');
    const err = await AdminPatientDocumentsApiService.uploadPatientDocument('p1', 'n', file).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(status);
    expect(err.code).toBe(code);
  });

  it('erro em chamada JSON (ex.: renomear com 400) também vira ApiError', async () => {
    fetchMock.mockResolvedValue(json({ success: false, error: 'x', code: 'INVALID_DOCUMENT_LABEL' }, 400));
    await expect(AdminPatientDocumentsApiService.renamePatientDocument('p1', 'd1', ' ')).rejects.toMatchObject({ status: 400, code: 'INVALID_DOCUMENT_LABEL' });
  });

  /**
   * ⚠️ Só o lado direito do `||` do construtor (`localhost:8080`) é alcançável daqui: `import.meta.env`
   * do vitest é reconstruído por módulo e `vi.stubEnv` não chega nele (medido — mesma lacuna documentada
   * em `AdminTherapeuticProjectsApiService.test.ts`). O molde `AdminConversationApiService` tem o mesmo desenho.
   */
});
