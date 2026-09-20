/**
 * AdminPatientsController.country.test.ts
 *
 * Covers Fase 4:
 *   - filtro país no list/stats (passthrough para o repo)
 *   - validação do endpoint de funil (400 em params inválidos)
 *   - adminPatientsListSchema aceita/rejeita country
 */

const mockList = jest.fn();
const mockStats = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({ query: jest.fn() }),
    }),
  },
}));

jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({
    encrypt: jest.fn(),
    decrypt: jest.fn(),
  })),
}));

jest.mock('../../../infrastructure/PatientQueryRepository', () => ({
  PatientQueryRepository: jest.fn().mockImplementation(() => ({
    list: mockList,
    stats: mockStats,
    findDetailById: jest.fn(),
  })),
}));

// PR-9 (`lex` #9): `getPatientStats`/`getPatientFunnel` resolvem o escopo de país
// (grupo do ator, `iam.effective_countries`) ANTES de chamar repo/use case — não
// mais o valor cru de `?country=`. Mocka só `resolveCountryScope`; o resto do
// módulo (`CountryScopeError`, `AuthMiddleware`) continua real.
const mockResolveCountryScope = jest.fn();
jest.mock('@modules/identity', () => {
  const actual = jest.requireActual('@modules/identity');
  return {
    ...actual,
    resolveCountryScope: (...args: unknown[]) => mockResolveCountryScope(...args),
  };
});

import { AdminPatientsController } from '../AdminPatientsController';
import { CountryScopeError } from '@modules/identity';
import { adminPatientsListSchema } from '../../validators/adminPatientsListSchema';
import { Request, Response } from 'express';

function mockReqRes(query: Record<string, string> = {}): [Request, Response] {
  const req = { params: {}, query, body: {} } as unknown as Request;
  const json = jest.fn().mockReturnThis();
  const status = jest.fn().mockReturnValue({ json });
  const res = { json, status } as unknown as Response;
  return [req, res];
}

describe('adminPatientsListSchema — country', () => {
  it('aceita AR', () => {
    expect(adminPatientsListSchema.parse({ country: 'AR' }).country).toBe('AR');
  });
  it('aceita BR', () => {
    expect(adminPatientsListSchema.parse({ country: 'BR' }).country).toBe('BR');
  });
  it('country ausente = undefined (todos os países)', () => {
    expect(adminPatientsListSchema.parse({}).country).toBeUndefined();
  });
  it('rejeita país inválido', () => {
    expect(adminPatientsListSchema.safeParse({ country: 'US' }).success).toBe(false);
  });
});

describe('AdminPatientsController — filtro país', () => {
  let controller: AdminPatientsController;
  beforeEach(() => {
    jest.clearAllMocks();
    controller = new AdminPatientsController();
  });

  it('listPatients repassa country=AR ao repo', async () => {
    mockList.mockResolvedValue({ rows: [], total: 0 });
    const [req, res] = mockReqRes({ country: 'AR' });
    await controller.listPatients(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ country: 'AR' }), expect.anything());
  });

  it('lex 08/09 — `search` sem `patient_identity:read` → 403 nomeando campo e célula; filtro clínico sem `patient_clinical:read` → 403; com as células (ou sem engine) passa', async () => {
    mockList.mockResolvedValue({ rows: [], total: 0 });
    const soOperacional = ['patient:read'];
    const [r1, s1] = mockReqRes({ search: 'Ana' });
    (r1 as unknown as { permissionCells: string[] }).permissionCells = soOperacional;
    await controller.listPatients(r1, s1);
    expect(s1.status).toHaveBeenCalledWith(403);
    expect(s1.json).toHaveBeenCalledWith(expect.objectContaining({ details: { field: 'search', cell: 'patient_identity:read' } }));
    expect(mockList).not.toHaveBeenCalled();
    // `search` só com espaço não é busca: passa.
    const [r1b, s1b] = mockReqRes({ search: '   ' });
    (r1b as unknown as { permissionCells: string[] }).permissionCells = soOperacional;
    await controller.listPatients(r1b, s1b);
    expect(s1b.status).toHaveBeenCalledWith(200);
    for (const [campo, valor] of [['clinical_specialty', 'NEUROLOGICAL'], ['dependency_level', 'MILD']] as const) {
      const [r2, s2] = mockReqRes({ [campo]: valor });
      (r2 as unknown as { permissionCells: string[] }).permissionCells = soOperacional;
      await controller.listPatients(r2, s2);
      expect(s2.status).toHaveBeenCalledWith(403);
      expect(s2.json).toHaveBeenCalledWith(expect.objectContaining({ details: { field: campo, cell: 'patient_clinical:read' } }));
    }
    mockList.mockClear();
    const [r3, s3] = mockReqRes({ search: 'Ana', clinical_specialty: 'NEUROLOGICAL' });
    (r3 as unknown as { permissionCells: string[] }).permissionCells = ['patient:read', 'patient_identity:read', 'patient_clinical:read'];
    await controller.listPatients(r3, s3);
    expect(s3.status).toHaveBeenCalledWith(200);
    expect(mockList).toHaveBeenCalledTimes(1);
    const [r4, s4] = mockReqRes({ search: 'Ana', dependency_level: 'MILD' }); // sem células: engine não decidiu → como antes
    await controller.listPatients(r4, s4);
    expect(s4.status).toHaveBeenCalledWith(200);
  });

  it('listPatients 400 em country inválido', async () => {
    const [req, res] = mockReqRes({ country: 'XX' });
    await controller.listPatients(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  // PR-9 (`lex` #9): país deixou de ser o valor cru de `?country=` repassado ao
  // repo — agora é `resolveCountryScope` (grupo do ator, `iam.effective_countries`)
  // quem decide `scope.countries`, e É esse array que chega no repo/use case.
  it('getPatientStats repassa scope.countries (resolvido) ao repo — nunca o `?country=` cru', async () => {
    mockStats.mockResolvedValue({});
    mockResolveCountryScope.mockResolvedValue({ countries: ['BR'], requested: 'BR' });
    const [req, res] = mockReqRes({ country: 'BR' });
    await controller.getPatientStats(req, res);
    expect(mockResolveCountryScope).toHaveBeenCalledWith(expect.anything(), undefined, 'BR');
    expect(mockStats).toHaveBeenCalledWith(['BR']);
  });

  it('getPatientStats sem country: resolvedor devolve ALL (união do ator) — repo recebe o array, não undefined', async () => {
    mockStats.mockResolvedValue({});
    mockResolveCountryScope.mockResolvedValue({ countries: ['AR', 'BR'], requested: 'ALL' });
    const [req, res] = mockReqRes({});
    await controller.getPatientStats(req, res);
    expect(mockResolveCountryScope).toHaveBeenCalledWith(expect.anything(), undefined, undefined);
    expect(mockStats).toHaveBeenCalledWith(['AR', 'BR']);
  });

  it('getPatientStats: país fora do escopo do ator → 403 (nunca chega no repo)', async () => {
    mockResolveCountryScope.mockRejectedValue(
      new CountryScopeError(403, 'COUNTRY_SCOPE_REQUIRED', 'Fora do escopo do ator: BR.'),
    );
    const [req, res] = mockReqRes({ country: 'BR' });
    await controller.getPatientStats(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'COUNTRY_SCOPE_REQUIRED',
      detail: 'Fora do escopo do ator: BR.',
    });
    expect(mockStats).not.toHaveBeenCalled();
  });

  it('getPatientStats: erro genérico (não CountryScopeError) ao resolver o escopo → 500, nunca chega no repo', async () => {
    mockResolveCountryScope.mockRejectedValue(new Error('banco fora do ar'));
    const [req, res] = mockReqRes({});
    await controller.getPatientStats(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Failed to resolve country scope' });
    expect(mockStats).not.toHaveBeenCalled();
  });

  it('getPatientStats: erro genérico NÃO-Error (valor cru rejeitado) ao resolver o escopo → 500 do mesmo jeito', async () => {
    mockResolveCountryScope.mockRejectedValue('banco fora do ar (valor cru)');
    const [req, res] = mockReqRes({});
    await controller.getPatientStats(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(mockStats).not.toHaveBeenCalled();
  });
});

describe('AdminPatientsController.getPatientFunnel — validação', () => {
  let controller: AdminPatientsController;
  beforeEach(() => {
    jest.clearAllMocks();
    controller = new AdminPatientsController();
    mockResolveCountryScope.mockResolvedValue({ countries: ['AR', 'BR'], requested: 'ALL' });
  });

  it('country inválido (fora de AR|BR|ALL): 400 vem do resolvedor, não mais do zod (country saiu do schema)', async () => {
    mockResolveCountryScope.mockRejectedValue(
      new CountryScopeError(400, 'INVALID_COUNTRY', 'country deve ser AR, BR ou ALL.'),
    );
    const [req, res] = mockReqRes({ country: 'US' });
    await controller.getPatientFunnel(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'INVALID_COUNTRY',
      detail: 'country deve ser AR, BR ou ALL.',
    });
  });

  it('país fora do escopo do ator → 403 (nunca chega no use case)', async () => {
    mockResolveCountryScope.mockRejectedValue(
      new CountryScopeError(403, 'COUNTRY_SCOPE_REQUIRED', 'Fora do escopo do ator: BR.'),
    );
    const [req, res] = mockReqRes({ country: 'BR' });
    await controller.getPatientFunnel(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('400 em from não-ISO (zod — `from`/`to` continuam validados aqui)', async () => {
    const [req, res] = mockReqRes({ from: 'ontem' });
    await controller.getPatientFunnel(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('erro genérico (não CountryScopeError) ao resolver o escopo → 500, nunca chega no use case', async () => {
    mockResolveCountryScope.mockRejectedValue(new Error('banco fora do ar'));
    const [req, res] = mockReqRes({});
    await controller.getPatientFunnel(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Failed to resolve country scope' });
  });

  it('erro genérico NÃO-Error (valor cru rejeitado) ao resolver o escopo → 500 do mesmo jeito', async () => {
    mockResolveCountryScope.mockRejectedValue('banco fora do ar (valor cru)');
    const [req, res] = mockReqRes({});
    await controller.getPatientFunnel(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
