/**
 * AnalyticsDashboardController.getManagementMetrics.test.ts (PR-9, `lex` #9)
 *
 * Cobre a fiação nova do PR-9 no método `getManagementMetrics`:
 *   - funnelPeriodDays inválido → 400 (comportamento pré-existente, preservado)
 *   - `resolveCountryScope` resolve e o use case recebe `countries`/`requested`
 *   - `CountryScopeError` (400 INVALID_COUNTRY / 403 COUNTRY_SCOPE_REQUIRED) vira
 *     o status HTTP correspondente, com `error`/`detail` do erro tipado
 *   - erro genérico (não CountryScopeError) continua caindo no catch → 500
 *
 * Mock de `DatabaseConnection` (padrão da casa, ver RecruitmentBlockedController.test.ts):
 * o construtor da classe pega `this.db` de `DatabaseConnection.getInstance().getPool()`.
 */
const mockExecute = jest.fn();
const mockResolveCountryScope = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({ query: jest.fn() }),
    }),
  },
}));

jest.mock('@shared/database/requestDbSession', () => ({
  currentDbContext: jest.fn().mockReturnValue({ kind: 'staff', uid: 'u1', country: 'AR' }),
}));

jest.mock('@modules/identity', () => {
  class CountryScopeError extends Error {
    constructor(public status: number, public code: string, message: string) {
      super(message);
    }
  }
  return {
    resolveCountryScope: (...args: unknown[]) => mockResolveCountryScope(...args),
    CountryScopeError,
  };
});

jest.mock('../../../application/GetManagementDashboardUseCase', () => ({
  GetManagementDashboardUseCase: jest.fn().mockImplementation(() => ({ execute: mockExecute })),
}));

jest.mock('@modules/identity/permissions', () => ({
  cellsOfRequest: jest.fn().mockReturnValue(null),
}));

import { AnalyticsDashboardController } from '../AnalyticsDashboardController';
import { currentDbContext } from '@shared/database/requestDbSession';
import { CountryScopeError } from '@modules/identity';

function makeReq(query: Record<string, unknown> = {}) {
  return { query } as unknown as import('express').Request;
}

function makeRes() {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  return res as unknown as import('express').Response & { status: jest.Mock; json: jest.Mock };
}

describe('AnalyticsDashboardController.getManagementMetrics', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (currentDbContext as jest.Mock).mockReturnValue({ kind: 'staff', uid: 'u1', country: 'AR' });
  });

  it('funnelPeriodDays fora de 7|30|90 → 400, nunca chega a resolver país', async () => {
    const controller = new AnalyticsDashboardController();
    const res = makeRes();
    await controller.getManagementMetrics(makeReq({ funnelPeriodDays: '15' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockResolveCountryScope).not.toHaveBeenCalled();
  });

  it('caminho feliz: resolve o escopo com uid do contexto e repassa countries/requested ao use case', async () => {
    mockResolveCountryScope.mockResolvedValue({ countries: ['AR'], requested: 'AR' });
    mockExecute.mockResolvedValue({ scope: { countries: ['AR'], requested: 'AR' }, bigNumbers: {} });

    const controller = new AnalyticsDashboardController();
    const res = makeRes();
    await controller.getManagementMetrics(makeReq({ country: 'AR' }), res);

    expect(mockResolveCountryScope).toHaveBeenCalledWith(expect.anything(), 'u1', 'AR');
    expect(mockExecute).toHaveBeenCalledWith({
      funnelPeriodDays: undefined,
      countries: ['AR'],
      requested: 'AR',
    });
    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, data: expect.any(Object) }),
    );
  });

  it('CountryScopeError 403 (COUNTRY_SCOPE_REQUIRED) vira 403 HTTP com o código e a mensagem do erro', async () => {
    mockResolveCountryScope.mockRejectedValue(
      new CountryScopeError(403, 'COUNTRY_SCOPE_REQUIRED', 'Fora do escopo do ator: BR.'),
    );

    const controller = new AnalyticsDashboardController();
    const res = makeRes();
    await controller.getManagementMetrics(makeReq({ country: 'BR' }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'COUNTRY_SCOPE_REQUIRED',
      detail: 'Fora do escopo do ator: BR.',
    });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('CountryScopeError 400 (INVALID_COUNTRY) vira 400 HTTP', async () => {
    mockResolveCountryScope.mockRejectedValue(
      new CountryScopeError(400, 'INVALID_COUNTRY', 'country deve ser AR, BR ou ALL.'),
    );

    const controller = new AnalyticsDashboardController();
    const res = makeRes();
    await controller.getManagementMetrics(makeReq({ country: 'US' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'INVALID_COUNTRY',
      detail: 'country deve ser AR, BR ou ALL.',
    });
  });

  it('erro genérico (não CountryScopeError) na resolução de país cai no catch geral → 500', async () => {
    mockResolveCountryScope.mockRejectedValue(new Error('banco fora do ar'));

    const controller = new AnalyticsDashboardController();
    const res = makeRes();
    await controller.getManagementMetrics(makeReq({}), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'banco fora do ar' });
  });

  it('erro do use case (depois do país resolvido) cai no catch geral → 500', async () => {
    mockResolveCountryScope.mockResolvedValue({ countries: ['AR', 'BR'], requested: 'ALL' });
    mockExecute.mockRejectedValue(new Error('agregação falhou'));

    const controller = new AnalyticsDashboardController();
    const res = makeRes();
    await controller.getManagementMetrics(makeReq({}), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'agregação falhou' });
  });

  it('sem uid no contexto (ex.: ALS ausente) repassa undefined ao resolvedor — quem decide o 403 é ele', async () => {
    (currentDbContext as jest.Mock).mockReturnValue(undefined);
    mockResolveCountryScope.mockRejectedValue(
      new CountryScopeError(403, 'COUNTRY_SCOPE_REQUIRED', 'Sem identidade de staff.'),
    );

    const controller = new AnalyticsDashboardController();
    const res = makeRes();
    await controller.getManagementMetrics(makeReq({}), res);

    expect(mockResolveCountryScope).toHaveBeenCalledWith(expect.anything(), undefined, undefined);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('funnelPeriodDays válido (30) segue normalmente até o use case', async () => {
    mockResolveCountryScope.mockResolvedValue({ countries: ['AR'], requested: 'ALL' });
    mockExecute.mockResolvedValue({ scope: { countries: ['AR'], requested: 'ALL' } });

    const controller = new AnalyticsDashboardController();
    const res = makeRes();
    await controller.getManagementMetrics(makeReq({ funnelPeriodDays: '30' }), res);

    expect(mockExecute).toHaveBeenCalledWith({
      funnelPeriodDays: 30,
      countries: ['AR'],
      requested: 'ALL',
    });
  });
});
