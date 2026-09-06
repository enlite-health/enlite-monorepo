/**
 * AdminContractedServicesApiService — CRUD do serviço contratado (spec 013, bloco C).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdminContractedServicesApiService, ContractedServiceApiError } from '../AdminContractedServicesApiService';

const mockGetIdToken = vi.fn().mockResolvedValue('mock-token');
vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({ getIdToken: (...a: unknown[]) => mockGetIdToken(...a) })),
}));

function mockFetch(payload: unknown, status = 200, contentType = 'application/json') {
  global.fetch = vi.fn().mockResolvedValue({
    ok: status < 400,
    status,
    json: () => Promise.resolve(payload),
    headers: { get: () => contentType },
  }) as unknown as typeof fetch;
  return global.fetch as unknown as ReturnType<typeof vi.fn>;
}

const PATIENT_ID = 'p1';
const SERVICE_ID = 's1';
const PROVIDER_ID = 'pr1';

describe('AdminContractedServicesApiService', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('listContractedServices: GET, devolve o array services', async () => {
    const f = mockFetch({ success: true, data: { services: [{ id: SERVICE_ID }] } });
    const out = await AdminContractedServicesApiService.listContractedServices(PATIENT_ID);
    expect(out).toEqual([{ id: SERVICE_ID }]);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/api/admin/patients/${PATIENT_ID}/contracted-services`);
    expect(init.method).toBe('GET');
  });

  it('createContractedService: POST com o corpo, devolve o serviço criado', async () => {
    const f = mockFetch({ success: true, data: { id: SERVICE_ID, serviceCode: 'AT' } });
    const out = await AdminContractedServicesApiService.createContractedService(PATIENT_ID, { serviceCode: 'AT' });
    expect(out).toEqual({ id: SERVICE_ID, serviceCode: 'AT' });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/api/admin/patients/${PATIENT_ID}/contracted-services`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ serviceCode: 'AT' });
  });

  it('updateContractedService: PATCH em /:sid — sem DELETE (lex C-a.4)', async () => {
    const f = mockFetch({ success: true, data: { id: SERVICE_ID, active: false } });
    const out = await AdminContractedServicesApiService.updateContractedService(PATIENT_ID, SERVICE_ID, { active: false });
    expect(out).toEqual({ id: SERVICE_ID, active: false });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/contracted-services/${SERVICE_ID}`);
    expect(init.method).toBe('PATCH');
  });

  it('associateProvider: POST em /:sid/providers', async () => {
    const f = mockFetch({ success: true, data: { id: PROVIDER_ID, workerId: 'w1' } });
    const out = await AdminContractedServicesApiService.associateProvider(PATIENT_ID, SERVICE_ID, { workerId: 'w1' });
    expect(out).toEqual({ id: PROVIDER_ID, workerId: 'w1' });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/contracted-services/${SERVICE_ID}/providers`);
    expect(init.method).toBe('POST');
  });

  it('updateProvider: PATCH em /:sid/providers/:pid — sem DELETE (lex C-e.2)', async () => {
    const f = mockFetch({ success: true, data: { id: PROVIDER_ID, active: false } });
    const out = await AdminContractedServicesApiService.updateProvider(PATIENT_ID, SERVICE_ID, PROVIDER_ID, { active: false });
    expect(out).toEqual({ id: PROVIDER_ID, active: false });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/providers/${PROVIDER_ID}`);
    expect(init.method).toBe('PATCH');
  });

  it('erro do backend (success:false) vira ContractedServiceApiError com status/code/details', async () => {
    mockFetch({ success: false, error: 'Worker already actively allocated to this service', code: 'PROVIDER_ALREADY_ACTIVE' }, 409);
    await expect(
      AdminContractedServicesApiService.associateProvider(PATIENT_ID, SERVICE_ID, { workerId: 'w1' }),
    ).rejects.toMatchObject({
      name: 'ContractedServiceApiError',
      status: 409,
      code: 'PROVIDER_ALREADY_ACTIVE',
    });
  });

  it('resposta sem content-type JSON (erro de conexão) vira ContractedServiceApiError genérico', async () => {
    mockFetch({}, 502, 'text/html');
    await expect(AdminContractedServicesApiService.listContractedServices(PATIENT_ID)).rejects.toBeInstanceOf(ContractedServiceApiError);
  });

  it('sem content-type header nenhum (`get` devolve null) cai no mesmo caminho de erro genérico', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 500, json: () => Promise.resolve({}), headers: { get: () => null },
    }) as unknown as typeof fetch;
    await expect(AdminContractedServicesApiService.listContractedServices(PATIENT_ID)).rejects.toBeInstanceOf(ContractedServiceApiError);
  });

  it('sem token (getIdToken devolve null): request sai sem Authorization', async () => {
    mockGetIdToken.mockResolvedValueOnce(null);
    const f = mockFetch({ success: true, data: { services: [] } });
    await AdminContractedServicesApiService.listContractedServices(PATIENT_ID);
    const [, init] = f.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('erro do backend sem campo `error` cai no fallback "HTTP <status>"', async () => {
    mockFetch({ success: false }, 500);
    await expect(AdminContractedServicesApiService.listContractedServices(PATIENT_ID)).rejects.toMatchObject({ message: 'HTTP 500' });
  });
});
