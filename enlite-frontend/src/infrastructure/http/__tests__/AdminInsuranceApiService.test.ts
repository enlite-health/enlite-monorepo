/**
 * AdminInsuranceApiService — obras sociais, contratos/termos, contatos e vínculo serviço → contrato (spec 058 Parte A).
 * Os corpos de resposta usados aqui são os da rodada 4 da A1 (progresso: "Contrato do fio para o front da A2").
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdminInsuranceApiService, InsuranceApiError } from '../AdminInsuranceApiService';

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
const callOf = (f: ReturnType<typeof vi.fn>): [string, RequestInit] => f.mock.calls[0] as [string, RequestInit];

const CONTRACT = {
  id: 'c1', name: 'Plan 210', country: 'AR', scopeDescription: null, asOf: '2026-10-19',
  currentTerm: { state: 'OK', termId: 't1', validFrom: '2026-09-01', validTo: null, taxRatePercent: 0, price: { state: 'OK', hourlyRate: 1500, currency: 'ARS' } },
  futureTerms: [{ state: 'OK', termId: 't2', validFrom: '2027-01-01', validTo: null, taxRatePercent: 21, price: { state: 'REDACTED' } }],
};

describe('AdminInsuranceApiService', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('listProviders: GET com busca e includeInactive só quando preenchidos; devolve items', async () => {
    const f = mockFetch({ success: true, data: { items: [{ code: 'OSDE', name: 'OSDE', payerKind: 'PREPAGA', active: true }] } });
    const out = await AdminInsuranceApiService.listProviders({ search: 'osd', includeInactive: true });
    expect(out).toEqual([{ code: 'OSDE', name: 'OSDE', payerKind: 'PREPAGA', active: true }]);
    const [url, init] = callOf(f);
    expect(url).toContain('/api/admin/insurance-providers?search=osd&includeInactive=true');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer mock-token');
  });

  it('listProviders sem filtro: sem query string (nada de ?search=undefined)', async () => {
    const f = mockFetch({ success: true, data: { items: [] } });
    await AdminInsuranceApiService.listProviders();
    expect(callOf(f)[0]).toMatch(/\/api\/admin\/insurance-providers$/);
  });

  it('listProvidersForService: país obrigatório + selected; devolve providers e o asOf do país', async () => {
    const f = mockFetch({ success: true, data: { providers: [{ code: 'OSDE', name: 'OSDE' }], asOf: '2026-10-19' } });
    const out = await AdminInsuranceApiService.listProvidersForService('AR', 'GALENO');
    expect(out).toEqual({ providers: [{ code: 'OSDE', name: 'OSDE' }], asOf: '2026-10-19' });
    expect(callOf(f)[0]).toContain('/api/admin/insurance-providers/for-service?country=AR&selected=GALENO');
  });

  it('createProvider: POST no catálogo só com o nome; getProvider/patchProvider usam /:code', async () => {
    let f = mockFetch({ success: true, data: { code: 'NUEVA', name: 'Nueva', active: true, sortOrder: 40 } }, 201);
    expect(await AdminInsuranceApiService.createProvider({ name: 'Nueva' })).toEqual({ code: 'NUEVA', name: 'Nueva', active: true, sortOrder: 40 });
    expect(callOf(f)[0]).toContain('/api/admin/catalogs/insurance-providers');
    expect(callOf(f)[1].method).toBe('POST');
    expect(JSON.parse(callOf(f)[1].body as string)).toEqual({ name: 'Nueva' });

    const detail = { code: 'OSDE', name: 'OSDE', payerKind: null, active: true, legalName: null, taxId: null, address: null, managementChatId: null, sortOrder: 15 };
    f = mockFetch({ success: true, data: detail });
    expect(await AdminInsuranceApiService.getProvider('OSDE')).toEqual(detail);
    expect(callOf(f)[0]).toContain('/api/admin/insurance-providers/OSDE');

    f = mockFetch({ success: true, data: { ...detail, payerKind: 'PREPAGA' } });
    await AdminInsuranceApiService.patchProvider('OSDE', { payerKind: 'PREPAGA', legalName: null });
    expect(callOf(f)[1].method).toBe('PATCH');
    expect(JSON.parse(callOf(f)[1].body as string)).toEqual({ payerKind: 'PREPAGA', legalName: null });
  });

  it('listContracts: offered/country na query; o preço REDACTED e o termo futuro passam no schema', async () => {
    const f = mockFetch({ success: true, data: { items: [CONTRACT] } });
    const out = await AdminInsuranceApiService.listContracts('OSDE', { offered: true, country: 'AR' });
    expect(out[0].futureTerms[0]).toMatchObject({ state: 'OK', price: { state: 'REDACTED' } });
    expect(callOf(f)[0]).toContain('/api/admin/insurance-providers/OSDE/contracts?offered=true&country=AR');
  });

  it('createContract / addTerm / supersedeTerm / patchContract: rotas e corpos', async () => {
    let f = mockFetch({ success: true, data: CONTRACT }, 201);
    await AdminInsuranceApiService.createContract('OSDE', { name: 'Plan 210', country: 'AR', firstTerm: { hourlyRate: 1500, taxRatePercent: 0, validFrom: '2026-09-01' } });
    expect(callOf(f)[0]).toContain('/api/admin/insurance-providers/OSDE/contracts');
    expect(JSON.parse(callOf(f)[1].body as string).firstTerm.taxRatePercent).toBe(0); // 0 = isento, viaja como número

    f = mockFetch({ success: true, data: CONTRACT });
    await AdminInsuranceApiService.addTerm('c1', { hourlyRate: 1800, taxRatePercent: 21, validFrom: '2027-01-01' });
    expect(callOf(f)[0]).toContain('/api/admin/insurance-contracts/c1/terms');

    f = mockFetch({ success: true, data: CONTRACT });
    await AdminInsuranceApiService.supersedeTerm('c1', 't1', { reason: 'CORRECTION', hourlyRate: 1500, taxRatePercent: 0, validFrom: '2026-09-01' });
    expect(callOf(f)[0]).toContain('/api/admin/insurance-contracts/c1/terms/t1/supersede');

    f = mockFetch({ success: true, data: CONTRACT });
    await AdminInsuranceApiService.patchContract('c1', { name: 'Plan 310' });
    expect(callOf(f)[1].method).toBe('PATCH');
    expect(callOf(f)[0]).toContain('/api/admin/insurance-contracts/c1');
  });

  it('contatos: lista, cria, edita e retira (POST …/retire); redacted chega no item', async () => {
    const contact = { id: 'k1', fullName: 'Ana', roleTitle: 'Auditora', phone: null, email: null, document: { type: 'DNI', number: null }, retired: false, redacted: true };
    let f = mockFetch({ success: true, data: { items: [contact] } });
    expect((await AdminInsuranceApiService.listContacts('OSDE'))[0].redacted).toBe(true);
    expect(callOf(f)[0]).toMatch(/\/contacts$/);
    f = mockFetch({ success: true, data: contact }, 201);
    await AdminInsuranceApiService.createContact('OSDE', { fullName: 'Ana', roleTitle: 'Auditora', phone: '11' });
    expect(callOf(f)[1].method).toBe('POST');
    f = mockFetch({ success: true, data: contact });
    await AdminInsuranceApiService.patchContact('OSDE', 'k1', { email: null });
    expect(callOf(f)[0]).toContain('/contacts/k1');
    f = mockFetch({ success: true, data: { ...contact, retired: true } });
    await AdminInsuranceApiService.retireContact('OSDE', 'k1');
    expect(callOf(f)[0]).toContain('/contacts/k1/retire');
  });

  it('§L listProviderPatients: país opcional; devolve items', async () => {
    const item = { patientId: 'p1', caseNumber: 12, contractedServiceId: 's1', contractName: 'Plan 210', validFrom: '2026-09-01', validTo: null, asOf: '2026-10-19' };
    const f = mockFetch({ success: true, data: { items: [item] } });
    expect(await AdminInsuranceApiService.listProviderPatients('OSDE', 'AR')).toEqual([item]);
    expect(callOf(f)[0]).toContain('/api/admin/insurance-providers/OSDE/patients?country=AR');
  });

  it('vínculo: create / end / supersede nas rotas contract-link e devolvem o serviço', async () => {
    let f = mockFetch({ success: true, data: { id: 's1' } }, 201);
    expect(await AdminInsuranceApiService.createContractLink('p1', 's1', { contractId: 'c1', validFrom: '2026-10-19' })).toEqual({ id: 's1' });
    expect(callOf(f)[0]).toMatch(/\/api\/admin\/patients\/p1\/contracted-services\/s1\/contract-link$/);
    f = mockFetch({ success: true, data: { id: 's1' } });
    await AdminInsuranceApiService.endContractLink('p1', 's1', { validTo: '2026-12-31' });
    expect(callOf(f)[0]).toMatch(/contract-link\/end$/);
    f = mockFetch({ success: true, data: { id: 's1' } });
    await AdminInsuranceApiService.supersedeContractLink('p1', 's1', { reason: 'SWITCHED', contractId: 'c2', validFrom: '2026-11-01' });
    expect(callOf(f)[0]).toMatch(/contract-link\/supersede$/);
    expect(JSON.parse(callOf(f)[1].body as string).reason).toBe('SWITCHED');
  });

  it('erro do back vira InsuranceApiError com status, code e details (o front traduz pelo code)', async () => {
    mockFetch({ success: false, error: 'Range overlap', code: 'RANGE_OVERLAP', details: { constraint: 'contracted_service_contract_sem_sobreposicao' } }, 409);
    const err = await AdminInsuranceApiService.createContractLink('p1', 's1', { contractId: 'c1', validFrom: '2026-10-19' }).catch((e) => e);
    expect(err).toBeInstanceOf(InsuranceApiError);
    expect(err).toMatchObject({ status: 409, code: 'RANGE_OVERLAP', details: { constraint: 'contracted_service_contract_sem_sobreposicao' } });
  });

  it('resposta que não é JSON (proxy/502) vira InsuranceApiError com o status', async () => {
    mockFetch({}, 502, 'text/html');
    await expect(AdminInsuranceApiService.listProviders()).rejects.toMatchObject({ name: 'InsuranceApiError', status: 502 });
  });

  it('drift de contrato quebra ALTO: chave desconhecida ou estado inventado no corpo é recusado (zod .strict)', async () => {
    mockFetch({ success: true, data: { items: [{ ...CONTRACT, extra: 1 }] } });
    await expect(AdminInsuranceApiService.listContracts('OSDE')).rejects.toThrow();
    mockFetch({ success: true, data: { items: [{ ...CONTRACT, currentTerm: { state: 'TALVEZ' } }] } });
    await expect(AdminInsuranceApiService.listContracts('OSDE')).rejects.toThrow();
  });
});
