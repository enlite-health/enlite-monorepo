/**
 * AdminInsuranceProvidersController — o cadastro de obras sociais (spec 012 US-B3; spec 058 §3.2 §W/§L).
 *   GET catálogo → 200 { providers }; 500 com reportError.
 *   POST → 400 (forma), 201, 409 por constraint (código/posição/nome), 422 NAME_NOT_CODIFIABLE, 500.
 *   PATCH → ausente não toca, null limpa, '' e `code` → 422; P0001 → 422; 404.
 *   for-service → `{code,name}` do país do serviço; §L → escopo de país do ator.
 */
jest.mock('@shared/logging', () => ({ reportError: jest.fn(), logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('@shared/database/DatabaseConnection', () => ({ DatabaseConnection: { getInstance: jest.fn(() => ({ getPool: jest.fn(() => ({})) })) } }));
const mockResolveScope = jest.fn();
jest.mock('@modules/identity', () => {
  class CountryScopeError extends Error {
    constructor(readonly status: number, readonly code: string, message: string) { super(message); }
  }
  return { resolveCountryScope: (...a: unknown[]) => mockResolveScope(...a), CountryScopeError, AuthMiddleware: { getAuthContext: () => undefined } };
});
jest.mock('@shared/database/actorContext', () => ({ withActorContext: jest.fn(async (_p: unknown, fn: (c: unknown) => Promise<unknown>) => fn({})) }));
const mockProviderPatientsRead = jest.fn();
jest.mock('../../../infrastructure/providerPatientsRead', () => ({ providerPatientsRead: (...a: unknown[]) => mockProviderPatientsRead(...a) }));

import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { CountryScopeError } from '@modules/identity';
import { AdminInsuranceProvidersController, createInsuranceProviderSchema } from '../AdminInsuranceProvidersController';
import {
  InsuranceProviderExistsError,
  InsuranceProviderSortOrderTakenError,
  InsuranceProviderNameExistsError,
  type InsuranceProviderRepository,
} from '../../../infrastructure/InsuranceProviderRepository';
import { NameNotCodifiableError } from '../../../infrastructure/deriveProviderCode';

function reqRes(over: { body?: unknown; params?: Record<string, string>; query?: Record<string, string> } = {}): [Request, Response, jest.Mock] {
  const json = jest.fn().mockReturnThis();
  const status = jest.fn().mockReturnValue({ json });
  return [
    { body: over.body ?? {}, params: over.params ?? {}, query: over.query ?? {} } as unknown as Request,
    { json, status } as unknown as Response,
    json,
  ];
}

describe('AdminInsuranceProvidersController', () => {
  const repo = { listActive: jest.fn(), create: jest.fn(), list: jest.fn(), get: jest.fn(), patch: jest.fn(), listForService: jest.fn() };
  const NOW = new Date('2026-10-19T02:00:00Z'); // 23h de 18/10 em Buenos Aires
  const ctrl = new AdminInsuranceProvidersController(repo as unknown as InsuranceProviderRepository, () => NOW);
  beforeEach(() => jest.clearAllMocks());

  it('list: 200 com os providers (e `name`); erro → 500 + reportError', async () => {
    repo.listActive.mockResolvedValueOnce([{ code: 'OSDE', name: 'OSDE', sortOrder: 15 }]);
    const [req, res, json] = reqRes();
    await ctrl.list(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ success: true, data: { providers: [{ code: 'OSDE', name: 'OSDE', sortOrder: 15 }] } });
    repo.listActive.mockRejectedValueOnce(new Error('db'));
    const [req3, res3] = reqRes();
    await ctrl.list(req3, res3);
    expect(res3.status).toHaveBeenCalledWith(500);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), { source: 'AdminInsuranceProvidersController:list' });
  });

  it('create: 400 sem nome ou com código fora da forma; 201 quando cria', async () => {
    const [bad, badRes] = reqRes({ body: { name: 'X', code: 'swiss medical' } });
    await ctrl.create(bad, badRes);
    expect(badRes.status).toHaveBeenCalledWith(400);
    const [semNome, semNomeRes] = reqRes({ body: { code: 'NUEVA' } });
    await ctrl.create(semNome, semNomeRes);
    expect(semNomeRes.status).toHaveBeenCalledWith(400);
    expect(repo.create).not.toHaveBeenCalled();
    repo.create.mockResolvedValueOnce({ code: 'NUEVA', name: 'Nueva', active: true, sortOrder: 34 });
    const [req, res] = reqRes({ body: { name: 'Nueva', aliases: ['Nueva OS'] } });
    await ctrl.create(req, res);
    expect(repo.create).toHaveBeenCalledWith({ name: 'Nueva', aliases: ['Nueva OS'] });
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('create: código existente → 409 INSURANCE_PROVIDER_CODE_EXISTS; outro erro → 500 + reportError', async () => {
    repo.create.mockRejectedValueOnce(new InsuranceProviderExistsError('OSDE'));
    const [req, res, json] = reqRes({ body: { name: 'OSDE' } });
    await ctrl.create(req, res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INSURANCE_PROVIDER_CODE_EXISTS', details: { code: 'OSDE' } }));
    repo.create.mockRejectedValueOnce(new Error('db'));
    const [req2, res2] = reqRes({ body: { name: 'OSDE' } });
    await ctrl.create(req2, res2);
    expect(res2.status).toHaveBeenCalledWith(500);
    expect(reportError).toHaveBeenCalled();
    repo.create.mockRejectedValueOnce('string');
    const [req3, res3] = reqRes({ body: { name: 'OSDE' } });
    await ctrl.create(req3, res3);
    expect(res3.status).toHaveBeenCalledWith(500);
  });

  it('create: posição ocupada → 409 falando da POSIÇÃO; nome repetido → 409 INSURANCE_PROVIDER_NAME_EXISTS', async () => {
    repo.create.mockRejectedValueOnce(new InsuranceProviderSortOrderTakenError(15));
    const [req, res, json] = reqRes({ body: { name: 'Nova OS', sortOrder: 15 } });
    await ctrl.create(req, res);
    expect(res.status).toHaveBeenCalledWith(409);
    const body = json.mock.calls[0][0];
    expect(body).toEqual({ success: false, error: 'Insurance provider sort_order already taken', code: 'INSURANCE_PROVIDER_SORT_ORDER_TAKEN', details: { sortOrder: 15 } });
    expect(JSON.stringify(body)).not.toContain('already exists');
    repo.create.mockRejectedValueOnce(new InsuranceProviderNameExistsError());
    const [req2, res2, json2] = reqRes({ body: { name: 'osde' } });
    await ctrl.create(req2, res2);
    expect(res2.status).toHaveBeenCalledWith(409);
    expect(json2.mock.calls[0][0].code).toBe('INSURANCE_PROVIDER_NAME_EXISTS');
  });

  it('create: nome sem caractere codificável → 422 NAME_NOT_CODIFIABLE (a tela pede o código)', async () => {
    repo.create.mockRejectedValueOnce(new NameNotCodifiableError());
    const [req, res, json] = reqRes({ body: { name: '日本' } });
    await ctrl.create(req, res);
    expect(res.status).toHaveBeenCalledWith(422);
    expect(json.mock.calls[0][0].code).toBe('NAME_NOT_CODIFIABLE');
  });

  it('create: o catch NÃO manda o corpo ao log (só o nome da operação)', async () => {
    repo.create.mockRejectedValueOnce(new Error('db'));
    const [req, res] = reqRes({ body: { name: 'Nome Que Nao Pode Vazar', aliases: ['rótulo secreto'] } });
    await ctrl.create(req, res);
    expect(JSON.stringify((reportError as jest.Mock).mock.calls)).not.toMatch(/Nao Pode Vazar|rótulo secreto/);
  });

  it('schema: aliases ≤ 20, sortOrder positivo, chave estranha recusada, nome obrigatório', () => {
    expect(createInsuranceProviderSchema.safeParse({ name: 'X1', sortOrder: 0 }).success).toBe(false);
    expect(createInsuranceProviderSchema.safeParse({ name: 'X1', aliases: Array(21).fill('a') }).success).toBe(false);
    expect(createInsuranceProviderSchema.safeParse({ name: 'X1', label: 'x' }).success).toBe(false);
    expect(createInsuranceProviderSchema.safeParse({ code: 'X1' }).success).toBe(false);
    expect(createInsuranceProviderSchema.safeParse({ name: 'X1' }).success).toBe(true);
  });

  it('get: 200; inexistente → 404 PROVIDER_NOT_FOUND', async () => {
    repo.get.mockResolvedValueOnce({ code: 'OSDE', name: 'OSDE' });
    const [req, res] = reqRes({ params: { code: 'OSDE' } });
    await ctrl.get(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    repo.get.mockResolvedValueOnce(null);
    const [req2, res2, json2] = reqRes({ params: { code: 'NADA' } });
    await ctrl.get(req2, res2);
    expect(res2.status).toHaveBeenCalledWith(404);
    expect(json2.mock.calls[0][0].code).toBe('PROVIDER_NOT_FOUND');
  });

  // ── PATCH: ausente / null / '' / code ──────────────────────────────────────
  it('patch: ausente = não toca, null = limpa — o repositório recebe exatamente as chaves presentes', async () => {
    repo.patch.mockResolvedValueOnce({ code: 'OSDE' });
    const [req, res] = reqRes({ params: { code: 'OSDE' }, body: { legalName: null, payerKind: 'PREPAGA' } });
    await ctrl.patch(req, res);
    expect(repo.patch).toHaveBeenCalledWith('OSDE', { legalName: null, payerKind: 'PREPAGA' });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("patch: '' → 422; null num campo NOT NULL (name, active) → 422; chave estranha → 422", async () => {
    for (const body of [{ taxId: '' }, { name: '   ' }, { name: null }, { active: null }, { foo: 1 }]) {
      const [req, res, json] = reqRes({ params: { code: 'OSDE' }, body });
      await ctrl.patch(req, res);
      expect(res.status).toHaveBeenCalledWith(422);
      expect(json.mock.calls[0][0].code).toBe('VALIDATION_FAILED');
    }
    expect(repo.patch).not.toHaveBeenCalled();
  });

  it('patch: `code` no corpo → 422 CODE_IMMUTABLE (o código nunca é recalculado)', async () => {
    const [req, res, json] = reqRes({ params: { code: 'OSDE' }, body: { code: 'OUTRO' } });
    await ctrl.patch(req, res);
    expect(res.status).toHaveBeenCalledWith(422);
    expect(json.mock.calls[0][0].code).toBe('CODE_IMMUTABLE');
    expect(repo.patch).not.toHaveBeenCalled();
  });

  it('patch: payerKind null num classificado (P0001 PAYER_KIND_CANNOT_UNSET) → 422; inexistente → 404', async () => {
    repo.patch.mockRejectedValueOnce(Object.assign(new Error('PAYER_KIND_CANNOT_UNSET'), { code: 'P0001' }));
    const [req, res, json] = reqRes({ params: { code: 'OSDE' }, body: { payerKind: null } });
    await ctrl.patch(req, res);
    expect(res.status).toHaveBeenCalledWith(422);
    expect(json.mock.calls[0][0].code).toBe('PAYER_KIND_CANNOT_UNSET');
    repo.patch.mockResolvedValueOnce(null);
    const [req2, res2] = reqRes({ params: { code: 'NADA' }, body: { active: false } });
    await ctrl.patch(req2, res2);
    expect(res2.status).toHaveBeenCalledWith(404);
  });

  it('patch: CHECK novo (private_kind_chk) → 422 INVALID_<constraint>', async () => {
    repo.patch.mockRejectedValueOnce(Object.assign(new Error('chk'), { code: '23514', constraint: 'insurance_providers_private_kind_chk' }));
    const [req, res, json] = reqRes({ params: { code: 'PRIVATE' }, body: { payerKind: 'PREPAGA' } });
    await ctrl.patch(req, res);
    expect(res.status).toHaveBeenCalledWith(422);
    expect(json.mock.calls[0][0].code).toBe('INVALID_insurance_providers_private_kind_chk');
  });

  // ── cascata do serviço ─────────────────────────────────────────────────────
  it('for-service: asOf é o dia LOCAL do país do serviço (AR ainda 18/10 às 02:00Z) e o `selected` vai ao repositório', async () => {
    repo.listForService.mockResolvedValueOnce([{ code: 'OSDE', name: 'OSDE' }]);
    const [req, res, json] = reqRes({ query: { country: 'AR', selected: 'GALENO' } });
    await ctrl.listForService(req, res);
    expect(repo.listForService).toHaveBeenCalledWith('AR', '2026-10-18', 'GALENO');
    expect(json.mock.calls[0][0]).toEqual({ success: true, data: { providers: [{ code: 'OSDE', name: 'OSDE' }], asOf: '2026-10-18' } });
  });

  it('for-service: country obrigatório e só AR|BR → 400', async () => {
    for (const query of [{} as Record<string, string>, { country: 'XX' }, { country: 'AR', selected: 'minúscula' }]) {
      const [req, res] = reqRes({ query });
      await ctrl.listForService(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    }
    expect(repo.listForService).not.toHaveBeenCalled();
  });

  // ── §L ─────────────────────────────────────────────────────────────────────
  it('§L: o mapa de datas só tem os países do ESCOPO do ator (só-AR não calcula BR)', async () => {
    mockResolveScope.mockResolvedValueOnce({ countries: ['AR'], requested: 'ALL' });
    repo.get.mockResolvedValueOnce({ code: 'OSDE' });
    mockProviderPatientsRead.mockResolvedValueOnce([{ patientId: 'p1' }]);
    const [req, res, json] = reqRes({ params: { code: 'OSDE' } });
    await ctrl.listPatients(req, res);
    expect(mockProviderPatientsRead).toHaveBeenCalledWith(expect.anything(), 'OSDE', { AR: '2026-10-18' });
    expect(json.mock.calls[0][0]).toEqual({ success: true, data: { items: [{ patientId: 'p1' }] } });
  });

  it('§L: escopo de país recusado → o status do CountryScopeError, sem consultar pacientes; erro de banco é erro (500), nunca []', async () => {
    mockResolveScope.mockRejectedValueOnce(new (CountryScopeError as unknown as new (s: number, c: string, m: string) => Error)(403, 'COUNTRY_SCOPE_REQUIRED', 'fora'));
    const [req, res] = reqRes({ params: { code: 'OSDE' }, query: { country: 'BR' } });
    await ctrl.listPatients(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockProviderPatientsRead).not.toHaveBeenCalled();
    mockResolveScope.mockResolvedValueOnce({ countries: ['AR'], requested: 'AR' });
    repo.get.mockResolvedValueOnce({ code: 'OSDE' });
    mockProviderPatientsRead.mockRejectedValueOnce(new Error('db'));
    const [req2, res2] = reqRes({ params: { code: 'OSDE' } });
    await ctrl.listPatients(req2, res2);
    expect(res2.status).toHaveBeenCalledWith(500);
  });

  it('§L: obra social inexistente → 404', async () => {
    mockResolveScope.mockResolvedValueOnce({ countries: ['AR'], requested: 'ALL' });
    repo.get.mockResolvedValueOnce(null);
    const [req, res] = reqRes({ params: { code: 'NADA' } });
    await ctrl.listPatients(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('construtor sem repositório injetado constrói o real (pool preguiçoso — não abre conexão)', () => {
    expect(new AdminInsuranceProvidersController()).toBeInstanceOf(AdminInsuranceProvidersController);
  });
});
