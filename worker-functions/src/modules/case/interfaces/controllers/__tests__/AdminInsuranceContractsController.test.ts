/**
 * AdminInsuranceContractsController — contrato e termos da obra social (spec 058 §3.2 §W/§T; plan §1.4).
 * Prova: o preço só sai a quem lê `patient_contract_value:read` (`redactTermForActor`, também nos termos futuros), o imposto nunca é redigido,
 * a lista é recortada pelo escopo de país do ator (T067), país/pagador são imutáveis (422), imposto é obrigatório e `0` é "isento".
 */
jest.mock('@shared/logging', () => ({ reportError: jest.fn(), logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('@shared/database/DatabaseConnection', () => ({ DatabaseConnection: { getInstance: () => ({ getPool: () => ({}) }) } }));
const mockResolveScope = jest.fn();
jest.mock('@modules/identity', () => {
  class CountryScopeError extends Error {
    constructor(readonly status: number, readonly code: string, message: string) { super(message); }
  }
  return {
    resolveCountryScope: (...a: unknown[]) => mockResolveScope(...a),
    CountryScopeError,
    AuthMiddleware: { getAuthContext: () => ({ principal: { id: 'uid-admin' } }) },
  };
});
const mockTermsOfContracts = jest.fn();
const mockOffered = jest.fn();
jest.mock('../../../infrastructure/insuranceContractTermRead', () => ({
  ...jest.requireActual('../../../infrastructure/insuranceContractTermRead'),
  termsOfContracts: (...a: unknown[]) => mockTermsOfContracts(...a),
  offeredContractsOf: (...a: unknown[]) => mockOffered(...a),
}));

import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { AdminInsuranceContractsController } from '../AdminInsuranceContractsController';
import type { InsuranceContractRepository, ContractHeader } from '../../../infrastructure/InsuranceContractRepository';
import type { InsuranceContractTermWriter } from '../../../infrastructure/insuranceContractTermWriter';
import { InsuranceContractNameExistsError } from '../../../infrastructure/InsuranceProviderRepository';
import { SameStartUseCorrectionError } from '../../../domain/rangeWriteErrors';
import type { TermRow } from '../../../infrastructure/insuranceContractTermRead';

const CONTRACT_AR = '33333333-3333-4333-8333-333333333333';
const CONTRACT_BR = '44444444-4444-4444-8444-444444444444';
const TERM = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2026-10-19T02:00:00Z'); // 18/10 em Buenos Aires e em São Paulo

const HEADERS: ContractHeader[] = [
  { id: CONTRACT_AR, providerCode: 'OSDE', name: 'Plan AR', country: 'AR', scopeDescription: null },
  { id: CONTRACT_BR, providerCode: 'OSDE', name: 'Plano BR', country: 'BR', scopeDescription: 'SP' },
];

const termRow = (contractId: string, country: string, over: Partial<TermRow> = {}): TermRow => ({
  termId: TERM, contractId, country, hourlyRate: 1500, taxRatePercent: 21, validFrom: '2026-03-01', validTo: null, ...over,
});

function reqRes(over: { body?: unknown; params?: Record<string, string>; query?: Record<string, string>; cells?: string[] | null } = {}): [Request, Response, jest.Mock] {
  const json = jest.fn().mockReturnThis();
  const status = jest.fn().mockReturnValue({ json });
  const req = {
    body: over.body ?? {},
    params: over.params ?? {},
    query: over.query ?? {},
    permissionCells: over.cells === undefined ? ['patient_contract_value:read'] : over.cells,
    user: { roles: ['admin'] },
  } as unknown as Request;
  return [req, { json, status } as unknown as Response, json];
}

describe('AdminInsuranceContractsController', () => {
  const repo = { providerExists: jest.fn(), listForProvider: jest.fn(), get: jest.fn(), patch: jest.fn() };
  const writer = { createContract: jest.fn(), addTerm: jest.fn(), supersedeTerm: jest.fn() };
  const ctrl = new AdminInsuranceContractsController(repo as unknown as InsuranceContractRepository, writer as unknown as InsuranceContractTermWriter, () => NOW);

  beforeEach(() => {
    jest.clearAllMocks();
    repo.providerExists.mockResolvedValue(true);
    // O recorte de país é do SQL real (`country = ANY($2)`): o dublê o reproduz para o teste medir QUEM decide a lista de países.
    repo.listForProvider.mockImplementation(async (_code: string, countries: string[]) => HEADERS.filter((h) => countries.includes(h.country)));
    mockTermsOfContracts.mockImplementation(async (_q: unknown, ids: string[]) => {
      const m = new Map();
      for (const id of ids) m.set(id, { current: termRow(id, id === CONTRACT_AR ? 'AR' : 'BR'), future: [termRow(id, id === CONTRACT_AR ? 'AR' : 'BR', { termId: 'futuro', hourlyRate: 1800, validFrom: '2027-01-01' })] });
      return m;
    });
  });

  it('só-AR não vê contrato BR: a lista nasce dos países do ESCOPO do ator (resolveCountryScope), nunca de AR+BR fixo', async () => {
    mockResolveScope.mockResolvedValueOnce({ countries: ['AR'], requested: 'ALL' });
    const [req, res, json] = reqRes({ params: { code: 'OSDE' } });
    await ctrl.list(req, res);
    expect(repo.listForProvider).toHaveBeenCalledWith('OSDE', ['AR']);
    const items = json.mock.calls[0][0].data.items;
    expect(items.map((i: { id: string }) => i.id)).toEqual([CONTRACT_AR]);
    expect(JSON.stringify(items)).not.toContain(CONTRACT_BR);
    // controle positivo: quem tem os dois países vê os dois
    mockResolveScope.mockResolvedValueOnce({ countries: ['AR', 'BR'], requested: 'ALL' });
    const [req2, res2, json2] = reqRes({ params: { code: 'OSDE' } });
    await ctrl.list(req2, res2);
    expect(json2.mock.calls[0][0].data.items.map((i: { id: string }) => i.id).sort()).toEqual([CONTRACT_AR, CONTRACT_BR].sort());
  });

  it('lista: item = { id, name, country, scopeDescription, asOf, currentTerm, futureTerms }; asOf é o dia local DE CADA país', async () => {
    mockResolveScope.mockResolvedValueOnce({ countries: ['AR'], requested: 'AR' });
    const [req, res, json] = reqRes({ params: { code: 'OSDE' } });
    await ctrl.list(req, res);
    expect(json.mock.calls[0][0].data.items[0]).toEqual({
      id: CONTRACT_AR, name: 'Plan AR', country: 'AR', scopeDescription: null, asOf: '2026-10-18',
      currentTerm: { state: 'OK', termId: TERM, validFrom: '2026-03-01', validTo: null, taxRatePercent: 21, price: { state: 'OK', hourlyRate: 1500, currency: 'ARS' } },
      futureTerms: [{ state: 'OK', termId: 'futuro', validFrom: '2027-01-01', validTo: null, taxRatePercent: 21, price: { state: 'OK', hourlyRate: 1800, currency: 'ARS' } }],
    });
    expect(mockTermsOfContracts).toHaveBeenCalledWith(expect.anything(), [CONTRACT_AR], '2026-10-18');
  });

  it('sem `patient_contract_value:read` o preço é REDACTED no termo vigente E nos futuros; o imposto continua visível', async () => {
    mockResolveScope.mockResolvedValueOnce({ countries: ['AR'], requested: 'AR' });
    const [req, res, json] = reqRes({ params: { code: 'OSDE' }, cells: ['insurance_contracts:read'] });
    await ctrl.list(req, res);
    const [item] = json.mock.calls[0][0].data.items;
    expect(item.currentTerm.price).toEqual({ state: 'REDACTED' });
    expect(item.futureTerms[0].price).toEqual({ state: 'REDACTED' });
    expect(item.currentTerm.taxRatePercent).toBe(21);
    expect(JSON.stringify(item)).not.toMatch(/1500|1800/);
  });

  it('sem termo vigente: currentTerm NO_TERM e os termos futuros listados', async () => {
    mockResolveScope.mockResolvedValueOnce({ countries: ['AR'], requested: 'AR' });
    mockTermsOfContracts.mockResolvedValueOnce(new Map([[CONTRACT_AR, { current: null, future: [termRow(CONTRACT_AR, 'AR', { validFrom: '2027-01-01' })] }]]));
    const [req, res, json] = reqRes({ params: { code: 'OSDE' } });
    await ctrl.list(req, res);
    const [item] = json.mock.calls[0][0].data.items;
    expect(item.currentTerm).toEqual({ state: 'NO_TERM' });
    expect(item.futureTerms).toHaveLength(1);
  });

  it('?offered=true usa o leitor §T por país do escopo (asOf local de cada um)', async () => {
    mockResolveScope.mockResolvedValueOnce({ countries: ['AR', 'BR'], requested: 'ALL' });
    mockOffered.mockImplementation(async (_q: unknown, _code: string, country: string) => HEADERS.filter((h) => h.country === country).map(({ providerCode: _p, ...o }) => o));
    const [req, res, json] = reqRes({ params: { code: 'OSDE' }, query: { offered: 'true' } });
    await ctrl.list(req, res);
    expect(mockOffered).toHaveBeenCalledWith(expect.anything(), 'OSDE', 'AR', '2026-10-18');
    expect(mockOffered).toHaveBeenCalledWith(expect.anything(), 'OSDE', 'BR', '2026-10-18');
    expect(repo.listForProvider).not.toHaveBeenCalled();
    expect(json.mock.calls[0][0].data.items).toHaveLength(2);
  });

  it('lista: obra social inexistente → 404; escopo recusado → status do CountryScopeError', async () => {
    mockResolveScope.mockResolvedValueOnce({ countries: ['AR'], requested: 'AR' });
    repo.providerExists.mockResolvedValueOnce(false);
    const [req, res] = reqRes({ params: { code: 'NADA' } });
    await ctrl.list(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    const { CountryScopeError } = jest.requireMock('@modules/identity');
    mockResolveScope.mockRejectedValueOnce(new CountryScopeError(403, 'COUNTRY_SCOPE_REQUIRED', 'fora'));
    const [req2, res2] = reqRes({ params: { code: 'OSDE' }, query: { country: 'BR' } });
    await ctrl.list(req2, res2);
    expect(res2.status).toHaveBeenCalledWith(403);
  });

  // ── escrita ────────────────────────────────────────────────────────────────
  const firstTerm = { hourlyRate: 1500, taxRatePercent: 0, validFrom: '2026-10-18' };

  it('create: contrato + 1º termo; imposto 0 ("isento") passa; resposta é o item com termo vigente', async () => {
    writer.createContract.mockResolvedValueOnce({ contractId: CONTRACT_AR, termId: TERM });
    repo.get.mockResolvedValueOnce(HEADERS[0]);
    const [req, res, json] = reqRes({ params: { code: 'OSDE' }, body: { name: 'Plan AR', country: 'AR', firstTerm } });
    await ctrl.create(req, res);
    expect(writer.createContract).toHaveBeenCalledWith(
      { providerCode: 'OSDE', name: 'Plan AR', country: 'AR', scopeDescription: null, firstTerm: { ...firstTerm, validTo: null } }, 'uid-admin');
    expect(res.status).toHaveBeenCalledWith(201);
    expect(json.mock.calls[0][0].data.id).toBe(CONTRACT_AR);
  });

  it('create: imposto OBRIGATÓRIO (ausente, vazio, negativo, > 100, 3 casas) → 422; valor-hora ≤ 0 → 422; data de calendário inexistente → 422', async () => {
    const ruins: Array<Record<string, unknown>> = [
      { ...firstTerm, taxRatePercent: undefined },
      { ...firstTerm, taxRatePercent: '' },
      { ...firstTerm, taxRatePercent: -1 },
      { ...firstTerm, taxRatePercent: 100.01 },
      { ...firstTerm, taxRatePercent: 10.123 },
      { ...firstTerm, hourlyRate: 0 },
      { ...firstTerm, validFrom: '2026-02-31' },
      { ...firstTerm, validTo: '2026-01-01' },
    ];
    for (const ft of ruins) {
      const [req, res, json] = reqRes({ params: { code: 'OSDE' }, body: { name: 'X', country: 'AR', firstTerm: ft } });
      await ctrl.create(req, res);
      expect(res.status).toHaveBeenCalledWith(422);
      expect(json.mock.calls[0][0].code).toBe('VALIDATION_FAILED');
    }
    const [req, res] = reqRes({ params: { code: 'OSDE' }, body: { name: 'X', country: 'US', firstTerm } });
    await ctrl.create(req, res);
    expect(res.status).toHaveBeenCalledWith(422);
    expect(writer.createContract).not.toHaveBeenCalled();
  });

  it('create: PAYER_KIND_REQUIRED (T5) → 422; nome repetido → 409 INSURANCE_CONTRACT_NAME_EXISTS; erro inesperado → 500 sem o corpo no log', async () => {
    writer.createContract.mockRejectedValueOnce(Object.assign(new Error('PAYER_KIND_REQUIRED'), { code: 'P0001' }));
    const [req, res, json] = reqRes({ params: { code: 'OSDE' }, body: { name: 'Plan', country: 'AR', firstTerm } });
    await ctrl.create(req, res);
    expect(res.status).toHaveBeenCalledWith(422);
    expect(json.mock.calls[0][0].code).toBe('PAYER_KIND_REQUIRED');
    writer.createContract.mockRejectedValueOnce(new InsuranceContractNameExistsError());
    const [req2, res2, json2] = reqRes({ params: { code: 'OSDE' }, body: { name: 'Plan', country: 'AR', firstTerm } });
    await ctrl.create(req2, res2);
    expect(res2.status).toHaveBeenCalledWith(409);
    expect(json2.mock.calls[0][0].code).toBe('INSURANCE_CONTRACT_NAME_EXISTS');
    writer.createContract.mockRejectedValueOnce(new Error('db'));
    const [req3, res3] = reqRes({ params: { code: 'OSDE' }, body: { name: 'Nome Que Nao Vaza', country: 'AR', firstTerm } });
    await ctrl.create(req3, res3);
    expect(res3.status).toHaveBeenCalledWith(500);
    expect(JSON.stringify((reportError as jest.Mock).mock.calls)).not.toContain('Nao Vaza');
  });

  it('patch: país e pagador são imutáveis → 422 IMMUTABLE_FIELD; só name/scopeDescription; null limpa a abrangência', async () => {
    for (const body of [{ country: 'BR' }, { providerCode: 'GALENO' }, { name: 'x', provider_code: 'GALENO' }]) {
      const [req, res, json] = reqRes({ params: { id: CONTRACT_AR }, body });
      await ctrl.patch(req, res);
      expect(res.status).toHaveBeenCalledWith(422);
      expect(json.mock.calls[0][0].code).toBe('IMMUTABLE_FIELD');
    }
    expect(repo.patch).not.toHaveBeenCalled();
    repo.patch.mockResolvedValueOnce(HEADERS[0]);
    repo.get.mockResolvedValueOnce(HEADERS[0]);
    const [req, res] = reqRes({ params: { id: CONTRACT_AR }, body: { scopeDescription: null } });
    await ctrl.patch(req, res);
    expect(repo.patch).toHaveBeenCalledWith(CONTRACT_AR, { scopeDescription: null }, 'uid-admin');
    expect(res.status).toHaveBeenCalledWith(200);
    const [r2, s2] = reqRes({ params: { id: CONTRACT_AR }, body: { name: '' } });
    await ctrl.patch(r2, s2);
    expect(s2.status).toHaveBeenCalledWith(422);
  });

  it('terms: termo novo 201; sobreposição (23P01) → 409 RANGE_OVERLAP; reajuste com mesmo início → 422 SAME_START_USE_CORRECTION', async () => {
    repo.get.mockResolvedValue(HEADERS[0]);
    writer.addTerm.mockResolvedValueOnce({ termId: 'novo' });
    const [req, res] = reqRes({ params: { id: CONTRACT_AR }, body: { hourlyRate: 1700, taxRatePercent: 10.5, validFrom: '2027-01-01' } });
    await ctrl.addTerm(req, res);
    expect(writer.addTerm).toHaveBeenCalledWith(CONTRACT_AR, { hourlyRate: 1700, taxRatePercent: 10.5, validFrom: '2027-01-01', validTo: null }, 'uid-admin');
    expect(res.status).toHaveBeenCalledWith(201);
    writer.addTerm.mockRejectedValueOnce(Object.assign(new Error('x'), { code: '23P01', constraint: 'insurance_contract_terms_sem_sobreposicao' }));
    const [req2, res2, json2] = reqRes({ params: { id: CONTRACT_AR }, body: { hourlyRate: 1700, taxRatePercent: 10.5, validFrom: '2027-01-01' } });
    await ctrl.addTerm(req2, res2);
    expect(res2.status).toHaveBeenCalledWith(409);
    expect(json2.mock.calls[0][0].code).toBe('RANGE_OVERLAP');
    writer.supersedeTerm.mockRejectedValueOnce(new SameStartUseCorrectionError());
    const [req3, res3, json3] = reqRes({ params: { id: CONTRACT_AR, termId: TERM }, body: { reason: 'REPRICED', hourlyRate: 1, taxRatePercent: 0, validFrom: '2026-03-01' } });
    await ctrl.supersedeTerm(req3, res3);
    expect(res3.status).toHaveBeenCalledWith(422);
    expect(json3.mock.calls[0][0].code).toBe('SAME_START_USE_CORRECTION');
  });

  it('supersede: razão fora de REPRICED|CORRECTION → 422; sucesso devolve o contrato relido (200)', async () => {
    const [req, res] = reqRes({ params: { id: CONTRACT_AR, termId: TERM }, body: { reason: 'QUALQUER', hourlyRate: 1, taxRatePercent: 0, validFrom: '2026-03-01' } });
    await ctrl.supersedeTerm(req, res);
    expect(res.status).toHaveBeenCalledWith(422);
    repo.get.mockResolvedValueOnce(HEADERS[0]);
    writer.supersedeTerm.mockResolvedValueOnce({ termId: 'n' });
    const [req2, res2] = reqRes({ params: { id: CONTRACT_AR, termId: TERM }, body: { reason: 'CORRECTION', hourlyRate: 1450, taxRatePercent: 21, validFrom: '2026-03-01' } });
    await ctrl.supersedeTerm(req2, res2);
    expect(writer.supersedeTerm).toHaveBeenCalledWith(CONTRACT_AR, TERM, { reason: 'CORRECTION', hourlyRate: 1450, taxRatePercent: 21, validFrom: '2026-03-01' }, 'uid-admin');
    expect(res2.status).toHaveBeenCalledWith(200);
  });

  it('D-43: o controller não tem CURRENT_DATE nem SQL (o "hoje" é operationDateOf do país, com UM relógio injetável)', () => {
    const fs = jest.requireActual('fs') as typeof import('fs');
    const path = jest.requireActual('path') as typeof import('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'AdminInsuranceContractsController.ts'), 'utf8')
      .split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
    expect(src).not.toMatch(/CURRENT_DATE|NOW\(\)/);
    expect(src).not.toMatch(/\b(SELECT|INSERT|UPDATE)\b/); // o controller não escreve SQL
    expect((src.match(/new Date\(\)/g) ?? []).length).toBe(1); // só o relógio injetável do construtor
  });
});
