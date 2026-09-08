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
