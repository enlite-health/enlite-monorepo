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

import { AdminPatientsController } from '../AdminPatientsController';
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

  it('listPatients 400 em country inválido', async () => {
    const [req, res] = mockReqRes({ country: 'XX' });
    await controller.listPatients(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('getPatientStats repassa country=BR ao repo', async () => {
    mockStats.mockResolvedValue({});
    const [req, res] = mockReqRes({ country: 'BR' });
    await controller.getPatientStats(req, res);
    expect(mockStats).toHaveBeenCalledWith('BR');
  });

  it('getPatientStats sem country repassa undefined (todos)', async () => {
    mockStats.mockResolvedValue({});
    const [req, res] = mockReqRes({});
    await controller.getPatientStats(req, res);
    expect(mockStats).toHaveBeenCalledWith(undefined);
  });
});

describe('AdminPatientsController.getPatientFunnel — validação', () => {
  let controller: AdminPatientsController;
  beforeEach(() => {
    jest.clearAllMocks();
    controller = new AdminPatientsController();
  });

  it('400 em country inválido', async () => {
    const [req, res] = mockReqRes({ country: 'US' });
    await controller.getPatientFunnel(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('400 em from não-ISO', async () => {
    const [req, res] = mockReqRes({ from: 'ontem' });
    await controller.getPatientFunnel(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
