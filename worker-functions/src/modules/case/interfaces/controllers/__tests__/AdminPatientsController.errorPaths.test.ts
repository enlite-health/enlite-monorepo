/**
 * AdminPatientsController — small uncovered branches: 400-on-invalid-id and
 * 500-on-generic-error catch blocks that had no test across:
 *   updatePatientTestFlag, purgeTestPatient, updatePatientStatus,
 *   activatePatient, listPatients, getPatientStats, getPatientFunnel.
 */

// ── Mocks (before importing the module under test) ────────────────────────────

const mockList = jest.fn();
const mockStats = jest.fn();
const mockSetTestFlag = jest.fn();
const mockPurge = jest.fn();

jest.mock('@shared/logging', () => ({
  reportError: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: jest.fn().mockReturnThis() },
}));

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({ query: jest.fn(), connect: jest.fn() }),
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
    findDetailById: jest.fn(),
    list: mockList,
    stats: mockStats,
  })),
}));

jest.mock('../../../application/PatientTestFixtureService', () => ({
  NotATestPatientError: class NotATestPatientError extends Error {},
  // Sem esta linha o `instanceof` do controller recebe `undefined` e estoura
  // ("Right-hand side of 'instanceof' is not an object") em TODO caminho de erro
  // do purge — o mock precisa exportar o que o módulo real exporta.
  TestVacancyHasApplicationsError: class TestVacancyHasApplicationsError extends Error {},
  PatientTestFixtureService: jest.fn().mockImplementation(() => ({
    setTestFlag: mockSetTestFlag,
    purge: mockPurge,
  })),
}));

jest.mock('@modules/matching', () => ({
  buildInsertQuery: jest.fn(),
  buildInsertParams: jest.fn(),
}));

// PR-9 (`lex` #9): `getPatientStats`/`getPatientFunnel` agora resolvem o escopo de
// país ANTES de chamar repo/use case. Este arquivo testa os catches DEPOIS do
// resolvedor — mocka só `resolveCountryScope` (sempre concede os dois países),
// preservando o resto do módulo real (`CountryScopeError`, `AuthMiddleware`).
jest.mock('@modules/identity', () => {
  const actual = jest.requireActual('@modules/identity');
  return {
    ...actual,
    resolveCountryScope: jest.fn().mockResolvedValue({ countries: ['AR', 'BR'], requested: 'ALL' }),
  };
});

import { reportError } from '@shared/logging';
import { AdminPatientsController } from '../AdminPatientsController';
import type { PatientService } from '../../../application/PatientService';
import { Request, Response } from 'express';

// ── Helpers ────────────────────────────────────────────────────────────────────

function mockReqRes(
  params: Record<string, unknown> = {},
  body: Record<string, unknown> = {},
  query: Record<string, unknown> = {},
): [Request, Response] {
  const req = { params, query, body } as unknown as Request;
  const json = jest.fn().mockReturnThis();
  const status = jest.fn().mockReturnValue({ json });
  const res = { json, status } as unknown as Response;
  return [req, res];
}

const VALID_ID = '11111111-1111-4111-8111-111111111111';

function makeController(opts: {
  moveStatus?: jest.Mock;
}): AdminPatientsController {
  const patientService = {
    moveStatus: opts.moveStatus ?? jest.fn(),
  } as unknown as PatientService;
  return new AdminPatientsController(undefined, undefined, patientService);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('AdminPatientsController — updatePatientTestFlag', () => {
  beforeEach(() => jest.clearAllMocks());

  it('400 quando o id não é UUID', async () => {
    const controller = new AdminPatientsController();
    const [req, res] = mockReqRes({ id: 'not-a-uuid' }, { isTest: true });

    await controller.updatePatientTestFlag(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect((res as any).json.mock.calls[0][0]).toMatchObject({ success: false, error: 'Invalid patient id' });
    expect(mockSetTestFlag).not.toHaveBeenCalled();
  });

  it('500 quando setTestFlag lança exceção', async () => {
    // Rejection with a NON-Error value exercises the `err instanceof Error`
    // false branch of the `const e = err instanceof Error ? err : new Error(...)`
    // guard present in every catch block of this controller.
    mockSetTestFlag.mockRejectedValueOnce('kv store down');
    const controller = new AdminPatientsController();
    const [req, res] = mockReqRes({ id: VALID_ID }, { isTest: true });

    await controller.updatePatientTestFlag(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect((res as any).json.mock.calls[0][0]).toMatchObject({
      success: false,
      error: 'Failed to update test flag',
    });
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'kv store down' }),
      { source: 'AdminPatientsController:updatePatientTestFlag' },
    );
  });

  it('500 quando setTestFlag rejeita com uma instância de Error (branch instanceof=true)', async () => {
    mockSetTestFlag.mockRejectedValueOnce(new Error('kv store down (Error instance)'));
    const controller = new AdminPatientsController();
    const [req, res] = mockReqRes({ id: VALID_ID }, { isTest: true });

    await controller.updatePatientTestFlag(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('AdminPatientsController — purgeTestPatient (500 genérico)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('500 quando purge lança um erro que NÃO é NotATestPatientError (valor não-Error → branch instanceof)', async () => {
    mockPurge.mockRejectedValueOnce('cascade delete failed');
    const controller = new AdminPatientsController();
    const [req, res] = mockReqRes({ id: VALID_ID });

    await controller.purgeTestPatient(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect((res as any).json.mock.calls[0][0]).toMatchObject({
      success: false,
      error: 'Failed to purge test patient',
    });
  });

  it('500 quando purge rejeita com uma instância de Error (branch instanceof=true)', async () => {
    mockPurge.mockRejectedValueOnce(new Error('cascade delete failed (Error instance)'));
    const controller = new AdminPatientsController();
    const [req, res] = mockReqRes({ id: VALID_ID });

    await controller.purgeTestPatient(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('AdminPatientsController — updatePatientStatus', () => {
  beforeEach(() => jest.clearAllMocks());

  it('400 quando o id (params) não é UUID', async () => {
    const moveStatus = jest.fn();
    const controller = makeController({ moveStatus });
    const [req, res] = mockReqRes({ id: 'not-a-uuid' }, { status: 'ACTIVE' });

    await controller.updatePatientStatus(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect((res as any).json.mock.calls[0][0]).toMatchObject({ success: false, error: 'Invalid params' });
    expect(moveStatus).not.toHaveBeenCalled();
  });

  it('500 quando moveStatus lança um erro que NÃO é "not found" (valor não-Error)', async () => {
    const moveStatus = jest.fn().mockRejectedValue('deadlock detected');
    const controller = makeController({ moveStatus });
    const [req, res] = mockReqRes({ id: VALID_ID }, { status: 'ACTIVE' });

    await controller.updatePatientStatus(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect((res as any).json.mock.calls[0][0]).toMatchObject({
      success: false,
      error: 'Failed to update patient status',
      details: 'deadlock detected',
    });
  });
});

describe('AdminPatientsController.listPatients — 500 genérico', () => {
  beforeEach(() => jest.clearAllMocks());

  it('500 quando repo.list lança exceção (valor não-Error)', async () => {
    mockList.mockRejectedValueOnce('query timeout');
    const controller = new AdminPatientsController();
    const [req, res] = mockReqRes({}, {}, {});

    await controller.listPatients(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect((res as any).json.mock.calls[0][0]).toMatchObject({
      success: false,
      error: 'Failed to list patients',
      details: 'query timeout',
    });
  });

  it('500 quando repo.list rejeita com uma instância de Error (branch instanceof=true)', async () => {
    mockList.mockRejectedValueOnce(new Error('query timeout (Error instance)'));
    const controller = new AdminPatientsController();
    const [req, res] = mockReqRes({}, {}, {});

    await controller.listPatients(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('AdminPatientsController.getPatientStats — 500 genérico', () => {
  beforeEach(() => jest.clearAllMocks());

  it('500 quando repo.stats lança exceção (valor não-Error)', async () => {
    mockStats.mockRejectedValueOnce('stats query failed');
    const controller = new AdminPatientsController();
    const [req, res] = mockReqRes({}, {}, {});

    await controller.getPatientStats(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect((res as any).json.mock.calls[0][0]).toMatchObject({
      success: false,
      error: 'Failed to get patient stats',
      details: 'stats query failed',
    });
  });

  it('500 quando repo.stats rejeita com uma instância de Error (branch instanceof=true)', async () => {
    mockStats.mockRejectedValueOnce(new Error('stats query failed (Error instance)'));
    const controller = new AdminPatientsController();
    const [req, res] = mockReqRes({}, {}, {});

    await controller.getPatientStats(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('AdminPatientsController.getPatientFunnel', () => {
  beforeEach(() => jest.clearAllMocks());

  it('200 happy path — devolve os dados do use case', async () => {
    const controller = new AdminPatientsController();
    const funnelData = { stages: [{ status: 'ADMISSION', count: 3 }] };
    (controller as unknown as { getPatientFunnelUseCase: { execute: jest.Mock } }).getPatientFunnelUseCase = {
      execute: jest.fn().mockResolvedValue(funnelData),
    };
    const [req, res] = mockReqRes({}, {}, {});

    await controller.getPatientFunnel(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect((res as any).json).toHaveBeenCalledWith({ success: true, data: funnelData });
  });

  it('500 quando o use case lança exceção (valor não-Error → branch instanceof)', async () => {
    const controller = new AdminPatientsController();
    // Reach into the private instance to force the use-case's execute to throw
    // (there is no constructor injection point for GetPatientFunnelUseCase).
    (controller as unknown as { getPatientFunnelUseCase: { execute: jest.Mock } }).getPatientFunnelUseCase = {
      execute: jest.fn().mockRejectedValue('funnel aggregation failed'),
    };
    const [req, res] = mockReqRes({}, {}, {});

    await controller.getPatientFunnel(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect((res as any).json.mock.calls[0][0]).toMatchObject({
      success: false,
      error: 'Failed to get patient funnel',
      details: 'funnel aggregation failed',
    });
  });

  it('500 quando o use case rejeita com uma instância de Error (branch instanceof=true)', async () => {
    const controller = new AdminPatientsController();
    (controller as unknown as { getPatientFunnelUseCase: { execute: jest.Mock } }).getPatientFunnelUseCase = {
      execute: jest.fn().mockRejectedValue(new Error('funnel aggregation failed (Error instance)')),
    };
    const [req, res] = mockReqRes({}, {}, {});

    await controller.getPatientFunnel(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});
