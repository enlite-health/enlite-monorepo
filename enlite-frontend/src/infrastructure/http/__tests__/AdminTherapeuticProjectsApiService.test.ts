/**
 * AdminTherapeuticProjectsApiService — versões do projeto terapêutico e os 3 catálogos (spec 017, D299).
 *
 * O que este arquivo prova, além do verbo/URL de cada método: a fronteira. Mock SÓ no `fetch` e no
 * `FirebaseAuthService` — o parser de resposta, o erro tipado e a montagem da URL são o código real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdminTherapeuticProjectsApiService, TherapeuticProjectApiError } from '../AdminTherapeuticProjectsApiService';
import type { CreateTherapeuticProjectBody, TherapeuticProjectVersionBody } from '@domain/entities/TherapeuticProject';

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

/** O par [url, init] da primeira chamada ao fetch. */
function chamada(f: ReturnType<typeof vi.fn>): [string, RequestInit] {
  return f.mock.calls[0] as [string, RequestInit];
}

const PATIENT_ID = 'p1';
const VERSION_ID = 'v1';
const ITEM_ID = 'i1';
const BASE = 'http://localhost:8080';

const CORPO: TherapeuticProjectVersionBody = {
  contractedServiceId: 'svc-1',
  modality: 'IN_PERSON',
  diagnoses: [{ uri: 'http://id.who.int/icd/entity/1', code: '6A00', title: 'Trastorno' }],
  clinicalContext: 'contexto',
  generalObjective: 'objetivo',
  specificObjectiveIds: ['so-1'],
  activityIds: ['a-1'],
  pathologyTypeIds: ['pt-1'],
  startDate: '2026-09-01',
  endDate: '2026-12-01',
};

describe('AdminTherapeuticProjectsApiService — cabeçalho e erros da fronteira', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetIdToken.mockResolvedValue('mock-token');
  });

  it('com token: manda Authorization Bearer e Content-Type JSON', async () => {
    const f = mockFetch({ success: true, data: { versions: [] } });
    await AdminTherapeuticProjectsApiService.listVersions(PATIENT_ID);
    const [, init] = chamada(f);
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer mock-token' });
  });

  it('sem token (getIdToken devolve null): a request sai SEM Authorization, não com "Bearer null"', async () => {
    mockGetIdToken.mockResolvedValueOnce(null);
    const f = mockFetch({ success: true, data: { versions: [] } });
    await AdminTherapeuticProjectsApiService.listVersions(PATIENT_ID);
    const [, init] = chamada(f);
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('GET não manda body (o `undefined` do JSON.stringify não vira "undefined")', async () => {
    const f = mockFetch({ success: true, data: { versions: [] } });
    await AdminTherapeuticProjectsApiService.listVersions(PATIENT_ID);
    expect(chamada(f)[1].body).toBeUndefined();
  });

  it('content-type NÃO-JSON vira TherapeuticProjectApiError com o STATUS na mensagem', async () => {
    // É o caso do 502 do balanceador com HTML: sem o status, o operador não sabe
    // distinguir "servidor fora" de "recusa".
    mockFetch('<html>502</html>', 502, 'text/html');
    await expect(AdminTherapeuticProjectsApiService.listVersions(PATIENT_ID)).rejects.toMatchObject({
      name: 'TherapeuticProjectApiError',
      status: 502,
      message: 'Erro ao conectar ao servidor (HTTP 502)',
    });
  });

  it('sem header content-type nenhum (`get` devolve null) cai no MESMO caminho', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 500, json: () => Promise.resolve({}), headers: { get: () => null },
    }) as unknown as typeof fetch;
    await expect(AdminTherapeuticProjectsApiService.listVersions(PATIENT_ID)).rejects.toBeInstanceOf(TherapeuticProjectApiError);
  });

  it('`success:false` vira TherapeuticProjectApiError com code e details (é o que a tela traduz)', async () => {
    mockFetch(
      { success: false, error: 'Label already exists', code: 'CATALOG_LABEL_DUPLICATE', details: { label: 'x' } },
      409,
    );
    const erro = await AdminTherapeuticProjectsApiService.listCatalog('activities').catch((e) => e);
    expect(erro).toBeInstanceOf(TherapeuticProjectApiError);
    expect(erro).toMatchObject({
      name: 'TherapeuticProjectApiError',
      message: 'Label already exists',
      status: 409,
      code: 'CATALOG_LABEL_DUPLICATE',
      details: { label: 'x' },
    });
  });

  it('`success:false` SEM `error` cai no fallback "HTTP <status>" — a recusa nunca fica muda', async () => {
    mockFetch({ success: false, error: '' }, 500);
    const erro = await AdminTherapeuticProjectsApiService.listVersions(PATIENT_ID).catch((e) => e);
    expect(erro.message).toBe('HTTP 500');
    expect(erro.code).toBeUndefined();
    expect(erro.details).toBeUndefined();
  });

  it('TherapeuticProjectApiError construído sem body: code e details ficam undefined', async () => {
    const erro = new TherapeuticProjectApiError('boom', 418);
    expect(erro).toBeInstanceOf(Error);
    expect(erro.status).toBe(418);
    expect(erro.code).toBeUndefined();
    expect(erro.details).toBeUndefined();
  });
});

describe('AdminTherapeuticProjectsApiService — versões do projeto (URL exata)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetIdToken.mockResolvedValue('mock-token');
  });

  it('listVersions: GET na coleção do paciente e devolve o array `versions` de dentro do envelope', async () => {
    const f = mockFetch({ success: true, data: { versions: [{ id: VERSION_ID }] } });
    const out = await AdminTherapeuticProjectsApiService.listVersions(PATIENT_ID);
    expect(out).toEqual([{ id: VERSION_ID }]);
    const [url, init] = chamada(f);
    expect(url).toBe(`${BASE}/api/admin/patients/${PATIENT_ID}/therapeutic-projects`);
    expect(init.method).toBe('GET');
  });

  it('getVersion SEM purpose: nenhuma query string', async () => {
    const f = mockFetch({ success: true, data: { id: VERSION_ID } });
    const out = await AdminTherapeuticProjectsApiService.getVersion(PATIENT_ID, VERSION_ID);
    expect(out).toEqual({ id: VERSION_ID });
    expect(chamada(f)[0]).toBe(`${BASE}/api/admin/patients/${PATIENT_ID}/therapeutic-projects/${VERSION_ID}`);
  });

  it('getVersion com `purpose: export` carrega ?purpose=export — é o que deixa a trilha export_pdf (lex C13)', async () => {
    const f = mockFetch({ success: true, data: { id: VERSION_ID } });
    await AdminTherapeuticProjectsApiService.getVersion(PATIENT_ID, VERSION_ID, { purpose: 'export' });
    expect(chamada(f)[0]).toBe(`${BASE}/api/admin/patients/${PATIENT_ID}/therapeutic-projects/${VERSION_ID}?purpose=export`);
  });

  it('createVersion mode:new: POST na coleção com o corpo inteiro, SEM major/minor (a numeração é do servidor)', async () => {
    const body: CreateTherapeuticProjectBody = { mode: 'new', version: CORPO };
    const f = mockFetch({ success: true, data: { id: VERSION_ID, version: 'V.2.0' } });
    const out = await AdminTherapeuticProjectsApiService.createVersion(PATIENT_ID, body);
    expect(out).toEqual({ id: VERSION_ID, version: 'V.2.0' });
    const [url, init] = chamada(f);
    expect(url).toBe(`${BASE}/api/admin/patients/${PATIENT_ID}/therapeutic-projects`);
    expect(init.method).toBe('POST');
    const enviado = JSON.parse(init.body as string);
    expect(enviado).toEqual(body);
    expect(enviado.version).not.toHaveProperty('major');
    expect(enviado.version).not.toHaveProperty('minor');
  });

  it('createVersion mode:edit leva o fromVersionId (a minor seguinte sai DAQUELA versão)', async () => {
    const body: CreateTherapeuticProjectBody = { mode: 'edit', fromVersionId: VERSION_ID, version: CORPO };
    const f = mockFetch({ success: true, data: { id: 'v2', version: 'V.1.1' } });
    await AdminTherapeuticProjectsApiService.createVersion(PATIENT_ID, body);
    expect(JSON.parse(chamada(f)[1].body as string)).toEqual(body);
  });

  it('annulVersion: POST em /:vid/annul com o motivo no corpo (lex C5 — anular exige razão)', async () => {
    const f = mockFetch({ success: true, data: { id: VERSION_ID, annulledAt: '2026-09-08T10:00:00Z' } });
    const out = await AdminTherapeuticProjectsApiService.annulVersion(PATIENT_ID, VERSION_ID, 'erro de digitação');
    expect(out).toMatchObject({ annulledAt: '2026-09-08T10:00:00Z' });
    const [url, init] = chamada(f);
    expect(url).toBe(`${BASE}/api/admin/patients/${PATIENT_ID}/therapeutic-projects/${VERSION_ID}/annul`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ reason: 'erro de digitação' });
  });
});

describe('AdminTherapeuticProjectsApiService — os 3 catálogos (D299, lex C19)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetIdToken.mockResolvedValue('mock-token');
  });

  it.each([
    ['specific-objectives'],
    ['activities'],
    ['pathology-types'],
  ] as const)('listCatalog(%s): GET na rota do kind, devolve `items` de dentro do envelope', async (kind) => {
    const f = mockFetch({ success: true, data: { kind, items: [{ id: ITEM_ID, label: 'Opção' }] } });
    const out = await AdminTherapeuticProjectsApiService.listCatalog(kind);
    expect(out).toEqual([{ id: ITEM_ID, label: 'Opção' }]);
    const [url, init] = chamada(f);
    expect(url).toBe(`${BASE}/api/admin/therapeutic-catalogs/${kind}`);
    expect(init.method).toBe('GET');
  });

  it('listCatalog com includeInactive:true carrega ?includeInactive=true — a tela de administração precisa ver o desligado', async () => {
    const f = mockFetch({ success: true, data: { kind: 'activities', items: [] } });
    await AdminTherapeuticProjectsApiService.listCatalog('activities', { includeInactive: true });
    expect(chamada(f)[0]).toBe(`${BASE}/api/admin/therapeutic-catalogs/activities?includeInactive=true`);
  });

  it('listCatalog com includeInactive:false NÃO manda a query (o default do servidor é só ativos)', async () => {
    const f = mockFetch({ success: true, data: { kind: 'activities', items: [] } });
    await AdminTherapeuticProjectsApiService.listCatalog('activities', { includeInactive: false });
    expect(chamada(f)[0]).toBe(`${BASE}/api/admin/therapeutic-catalogs/activities`);
  });

  it('createCatalogItem: POST na rota do kind com label e sortOrder', async () => {
    const f = mockFetch({ success: true, data: { id: ITEM_ID, label: 'Nova', sortOrder: 3 } });
    const out = await AdminTherapeuticProjectsApiService.createCatalogItem('pathology-types', { label: 'Nova', sortOrder: 3 });
    expect(out).toMatchObject({ id: ITEM_ID });
    const [url, init] = chamada(f);
    expect(url).toBe(`${BASE}/api/admin/therapeutic-catalogs/pathology-types`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ label: 'Nova', sortOrder: 3 });
  });

  it('updateCatalogItem: PATCH em /:itemId — Merge Patch, sem DELETE (desativar NÃO apaga, lex C19)', async () => {
    const f = mockFetch({ success: true, data: { id: ITEM_ID, active: false } });
    const out = await AdminTherapeuticProjectsApiService.updateCatalogItem('specific-objectives', ITEM_ID, { active: false });
    expect(out).toMatchObject({ active: false });
    const [url, init] = chamada(f);
    expect(url).toBe(`${BASE}/api/admin/therapeutic-catalogs/specific-objectives/${ITEM_ID}`);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ active: false });
  });

  it('updateCatalogItem só com `label` manda só o label (renomear não reordena nem reativa)', async () => {
    const f = mockFetch({ success: true, data: { id: ITEM_ID, label: 'Renomeada' } });
    await AdminTherapeuticProjectsApiService.updateCatalogItem('activities', ITEM_ID, { label: 'Renomeada' });
    expect(JSON.parse(chamada(f)[1].body as string)).toEqual({ label: 'Renomeada' });
  });
});

describe('AdminTherapeuticProjectsApiService — baseURL', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetIdToken.mockResolvedValue('mock-token');
  });

  /**
   * ⚠️ Só o LADO DIREITO do `||` do construtor é alcançável a partir de um teste.
   * `import.meta.env` do vitest 1.4 é reconstruído a cada execução do módulo a partir da config do
   * Vite: `vi.stubEnv`, mutar `import.meta.env` e mexer em `process.env` — os três medidos em 08/09 —
   * NÃO chegam ao módulo reexecutado por `vi.resetModules()`. É a mesma lacuna do irmão
   * `AdminContractedServicesApiService` (o piso dele no vitest.config.ts omite `branches` por isso).
   */
  it('sem VITE_API_WORKER_FUNCTIONS_URL no ambiente de teste, a base cai no localhost:8080', async () => {
    const f = mockFetch({ success: true, data: { versions: [] } });
    await AdminTherapeuticProjectsApiService.listVersions(PATIENT_ID);
    expect(chamada(f)[0]).toBe(`${BASE}/api/admin/patients/${PATIENT_ID}/therapeutic-projects`);
  });
});
