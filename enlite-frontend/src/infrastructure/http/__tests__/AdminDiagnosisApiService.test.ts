/**
 * AdminDiagnosisApiService — CRUD do diagnóstico estruturado (spec 016 F3).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdminDiagnosisApiService, DiagnosisApiError } from '../AdminDiagnosisApiService';

const mockGetIdToken = vi.fn().mockResolvedValue('mock-token');
vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({ getIdToken: (...a: unknown[]) => mockGetIdToken(...a) })),
}));

function mockFetch(payload: unknown, status = 200, contentType = 'application/json') {
  global.fetch = vi.fn().mockResolvedValue({
    status,
    json: () => Promise.resolve(payload),
    headers: { get: () => contentType },
  }) as unknown as typeof fetch;
  return global.fetch as unknown as ReturnType<typeof vi.fn>;
}

const PATIENT_ID = 'p1';
const DIAGNOSIS_ID = 'd1';
const VIEW = { id: DIAGNOSIS_ID, uri: 'u1', title: 'Esquizofrenia', isPrimary: false, source: 'PANEL', active: true };

describe('AdminDiagnosisApiService', () => {
  beforeEach(() => { vi.clearAllMocks(); mockGetIdToken.mockResolvedValue('mock-token'); });

  it('create: POST com conceptUri, sem isPrimary quando omitido', async () => {
    const f = mockFetch({ success: true, data: VIEW }, 201);
    const out = await AdminDiagnosisApiService.create(PATIENT_ID, 'u1');
    expect(out).toEqual(VIEW);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/api/admin/patients/${PATIENT_ID}/diagnoses`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ conceptUri: 'u1' });
  });

  it('create: com isPrimary=true, o corpo carrega o campo', async () => {
    const f = mockFetch({ success: true, data: { ...VIEW, isPrimary: true } }, 201);
    await AdminDiagnosisApiService.create(PATIENT_ID, 'u1', true);
    const [, init] = f.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ conceptUri: 'u1', isPrimary: true });
  });

  it('promote: PATCH { isPrimary: true }', async () => {
    const f = mockFetch({ success: true, data: { ...VIEW, isPrimary: true } });
    const out = await AdminDiagnosisApiService.promote(PATIENT_ID, DIAGNOSIS_ID);
    expect(out.isPrimary).toBe(true);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/diagnoses/${DIAGNOSIS_ID}`);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ isPrimary: true });
  });

  it('deactivate: PATCH { active: false } — nunca DELETE', async () => {
    const f = mockFetch({ success: true, data: { ...VIEW, active: false } });
    const out = await AdminDiagnosisApiService.deactivate(PATIENT_ID, DIAGNOSIS_ID);
    expect(out.active).toBe(false);
    const [, init] = f.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ active: false });
  });

  it('erro do backend (success:false) vira DiagnosisApiError com status/code', async () => {
    mockFetch({ success: false, error: 'conceptUri does not resolve', code: 'CONCEPT_NOT_RESOLVED' }, 422);
    await expect(AdminDiagnosisApiService.create(PATIENT_ID, 'bogus')).rejects.toMatchObject({
      name: 'DiagnosisApiError',
      status: 422,
      code: 'CONCEPT_NOT_RESOLVED',
    });
  });

  it('erro do backend sem `error` cai no fallback "HTTP <status>"', async () => {
    mockFetch({ success: false }, 500);
    await expect(AdminDiagnosisApiService.promote(PATIENT_ID, DIAGNOSIS_ID)).rejects.toThrow('HTTP 500');
  });

  it('resposta sem content-type JSON vira DiagnosisApiError genérico', async () => {
    mockFetch({}, 502, 'text/html');
    await expect(AdminDiagnosisApiService.deactivate(PATIENT_ID, DIAGNOSIS_ID)).rejects.toBeInstanceOf(DiagnosisApiError);
  });

  it('sem content-type header nenhum (`get` devolve null) cai no mesmo caminho de erro genérico', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      status: 500, json: () => Promise.resolve({}), headers: { get: () => null },
    }) as unknown as typeof fetch;
    await expect(AdminDiagnosisApiService.deactivate(PATIENT_ID, DIAGNOSIS_ID)).rejects.toBeInstanceOf(DiagnosisApiError);
  });

  it('sem token (getIdToken devolve null): request sai sem Authorization', async () => {
    mockGetIdToken.mockResolvedValueOnce(null);
    const f = mockFetch({ success: true, data: VIEW }, 201);
    await AdminDiagnosisApiService.create(PATIENT_ID, 'u1');
    const [, init] = f.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});
