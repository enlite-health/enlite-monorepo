/**
 * AdminPatientsController.test.ts
 *
 * Covers:
 *   - getPatientById (cenários 1-5)
 *   - listPatientVacancies (cenários 6-9)
 *   - listPatients — caseNumber field + case_number filter (cenários 10-12)
 */

// ─── Mocks (antes de qualquer import do módulo) ───────────────────────────────

const mockFindDetailById = jest.fn();
const mockList = jest.fn();
const mockFetchPatientVacancies = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({ query: jest.fn() }),
    }),
  },
}));

jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({
    encrypt: jest.fn().mockResolvedValue('enc'),
    decrypt: jest.fn().mockResolvedValue(null),
  })),
}));

// Mock PatientQueryRepository so findDetailById and list are controlled
jest.mock('../../../infrastructure/PatientQueryRepository', () => ({
  PatientQueryRepository: jest.fn().mockImplementation(() => ({
    findDetailById: mockFindDetailById,
    list: mockList,
    stats: jest.fn(),
  })),
}));

// Mock PatientVacanciesQueryHelper
jest.mock('../../../infrastructure/PatientVacanciesQueryHelper', () => ({
  fetchPatientVacancies: (...args: unknown[]) => mockFetchPatientVacancies(...args),
}));

import { AdminPatientsController } from '../AdminPatientsController';
import { Request, Response } from 'express';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PATIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function mockReqRes(
  params: Record<string, string> = {},
): [Request, Response] {
  const req = { params, query: {}, body: {} } as unknown as Request;
  const json = jest.fn().mockReturnThis();
  const status = jest.fn().mockReturnValue({ json });
  const res = { json, status } as unknown as Response;
  return [req, res];
}

function makePatientDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: PATIENT_ID,
    clickupTaskId: 'CU-001',
    firstName: 'Juan',
    lastName: 'Pérez',
    birthDate: new Date('1990-05-15'),
    documentType: 'DNI',
    documentNumber: '12345678',
    affiliateId: null,
    sex: 'MALE',
    phoneWhatsapp: '+5491100000000',
    diagnosis: 'ASD',
    dependencyLevel: 'MODERATE',
    clinicalSpecialty: 'ASD',
    clinicalSegments: null,
    serviceType: ['AT'],
    deviceType: null,
    additionalComments: null,
    hasJudicialProtection: false,
    hasCud: true,
    hasConsent: true,
    insuranceInformed: 'OSDE',
    insuranceVerified: null,
    cityLocality: 'CABA',
    province: 'Buenos Aires',
    zoneNeighborhood: null,
    country: 'AR',
    status: 'ACTIVE',
    needsAttention: false,
    attentionReasons: [],
    responsibles: [],
    addresses: [],
    professionals: [],
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-06-01T00:00:00Z'),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AdminPatientsController.getPatientById', () => {
  let controller: AdminPatientsController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new AdminPatientsController();
  });

  describe('Cenário 1 — Paciente encontrado', () => {
    it('deve retornar 200 com success:true e data quando paciente existe', async () => {
      const patient = makePatientDetail();
      mockFindDetailById.mockResolvedValue(patient);

      const [req, res] = mockReqRes({ id: PATIENT_ID });
      await controller.getPatientById(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect((res as any).json).toHaveBeenCalledWith({ success: true, data: patient });
    });

    it('deve incluir responsibles, addresses e professionals no data', async () => {
      const patient = makePatientDetail({
        responsibles: [{ id: 'r1', firstName: 'María', isPrimary: true }],
        addresses: [{ id: 'a1', addressType: 'primary' }],
        professionals: [{ id: 'pr1', name: 'Dr. García' }],
      });
      mockFindDetailById.mockResolvedValue(patient);

      const [req, res] = mockReqRes({ id: PATIENT_ID });
      await controller.getPatientById(req, res);

      const jsonArg = (res as any).json.mock.calls[0][0];
      expect(jsonArg.data.responsibles).toHaveLength(1);
      expect(jsonArg.data.addresses).toHaveLength(1);
      expect(jsonArg.data.professionals).toHaveLength(1);
    });
  });

  describe('Cenário 2 — Paciente não encontrado', () => {
    it('deve retornar 404 quando findDetailById retorna null', async () => {
      mockFindDetailById.mockResolvedValue(null);

      const [req, res] = mockReqRes({ id: PATIENT_ID });
      await controller.getPatientById(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect((res as any).json).toHaveBeenCalledWith({
        success: false,
        error: 'Patient not found',
      });
    });
  });

  describe('Cenário 3 — UUID inválido', () => {
    it('deve retornar 400 para id que não é UUID', async () => {
      const [req, res] = mockReqRes({ id: 'not-a-uuid' });
      await controller.getPatientById(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect((res as any).json.mock.calls[0][0]).toMatchObject({
        success: false,
        error: 'Invalid params',
      });
    });

    it('deve retornar 400 quando id está ausente', async () => {
      const [req, res] = mockReqRes({});
      await controller.getPatientById(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('não deve chamar o use case quando params são inválidos', async () => {
      const [req, res] = mockReqRes({ id: '12345' });
      await controller.getPatientById(req, res);

      expect(mockFindDetailById).not.toHaveBeenCalled();
    });
  });

  describe('Cenário 4 — Erro interno', () => {
    it('deve retornar 500 quando o use case lança exceção', async () => {
      mockFindDetailById.mockRejectedValue(new Error('DB timeout'));

      const [req, res] = mockReqRes({ id: PATIENT_ID });
      await controller.getPatientById(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect((res as any).json.mock.calls[0][0]).toMatchObject({
        success: false,
        error: 'Failed to get patient details',
        details: 'DB timeout',
      });
    });
  });

  describe('Cenário 5 — Paciente sem relacionamentos', () => {
    it('deve retornar 200 com arrays vazios quando paciente não tem responsáveis/endereços/profissionais', async () => {
      const patient = makePatientDetail({
        responsibles: [],
        addresses: [],
        professionals: [],
      });
      mockFindDetailById.mockResolvedValue(patient);

      const [req, res] = mockReqRes({ id: PATIENT_ID });
      await controller.getPatientById(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      const jsonArg = (res as any).json.mock.calls[0][0];
      expect(jsonArg.data.responsibles).toEqual([]);
      expect(jsonArg.data.addresses).toEqual([]);
      expect(jsonArg.data.professionals).toEqual([]);
    });
  });
});

// ─── listPatientVacancies ─────────────────────────────────────────────────────

describe('AdminPatientsController.listPatientVacancies', () => {
  let controller: AdminPatientsController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new AdminPatientsController();
  });

  const makeVacancy = (overrides: Record<string, unknown> = {}) => ({
    id: 'vvvvvvvv-0000-0000-0000-000000000001',
    caseNumber: 766,
    vacancyNumber: 1,
    title: 'CASO 766-1',
    status: 'SEARCHING',
    isDraft: false,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  });

  describe('Cenário 6 — Happy path', () => {
    it('deve retornar 200 com a lista de vagas do paciente', async () => {
      const vacancies = [makeVacancy(), makeVacancy({ id: 'vvvvvvvv-0000-0000-0000-000000000002', vacancyNumber: 2 })];
      mockFetchPatientVacancies.mockResolvedValue(vacancies);

      const [req, res] = mockReqRes({ id: PATIENT_ID });
      await controller.listPatientVacancies(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      const jsonArg = (res as any).json.mock.calls[0][0];
      expect(jsonArg.success).toBe(true);
      expect(jsonArg.data).toHaveLength(2);
      expect(jsonArg.data[0].caseNumber).toBe(766);
      expect(jsonArg.data[0].isDraft).toBe(false);
    });

    it('deve retornar array vazio quando paciente não tem vagas', async () => {
      mockFetchPatientVacancies.mockResolvedValue([]);

      const [req, res] = mockReqRes({ id: PATIENT_ID });
      await controller.listPatientVacancies(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect((res as any).json.mock.calls[0][0]).toEqual({ success: true, data: [] });
    });
  });

  describe('Cenário 7 — UUID inválido', () => {
    it('deve retornar 400 para id que não é UUID', async () => {
      const [req, res] = mockReqRes({ id: 'not-a-uuid' });
      await controller.listPatientVacancies(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect((res as any).json.mock.calls[0][0]).toMatchObject({
        success: false,
        error: 'Invalid params',
      });
      expect(mockFetchPatientVacancies).not.toHaveBeenCalled();
    });
  });

  describe('Cenário 8 — Erro interno', () => {
    it('deve retornar 500 quando fetchPatientVacancies lança exceção', async () => {
      mockFetchPatientVacancies.mockRejectedValue(new Error('DB error'));

      const [req, res] = mockReqRes({ id: PATIENT_ID });
      await controller.listPatientVacancies(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect((res as any).json.mock.calls[0][0]).toMatchObject({
        success: false,
        error: 'Failed to list patient vacancies',
        details: 'DB error',
      });
    });
  });

  describe('Cenário 9 — Campos retornados', () => {
    it('deve retornar os campos canônicos de cada vaga', async () => {
      const vaga = makeVacancy({ isDraft: true, status: 'DRAFT', caseNumber: null });
      mockFetchPatientVacancies.mockResolvedValue([vaga]);

      const [req, res] = mockReqRes({ id: PATIENT_ID });
      await controller.listPatientVacancies(req, res);

      const data = (res as any).json.mock.calls[0][0].data[0];
      expect(data).toHaveProperty('id');
      expect(data).toHaveProperty('caseNumber', null);
      expect(data).toHaveProperty('vacancyNumber');
      expect(data).toHaveProperty('title');
      expect(data).toHaveProperty('status');
      expect(data).toHaveProperty('isDraft', true);
      expect(data).toHaveProperty('createdAt');
    });
  });
});

// ─── listPatients — caseNumber field ─────────────────────────────────────────

describe('AdminPatientsController.listPatients — caseNumber', () => {
  let controller: AdminPatientsController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new AdminPatientsController();
  });

  function mockReqResWithQuery(query: Record<string, string>): [Request, Response] {
    const req = { params: {}, query, body: {} } as unknown as Request;
    const json = jest.fn().mockReturnThis();
    const status = jest.fn().mockReturnValue({ json });
    const res = { json, status } as unknown as Response;
    return [req, res];
  }

  const baseRow = {
    id: PATIENT_ID,
    clickupTaskId: 'CU-002',
    firstName: 'Ana',
    lastName: 'García',
    diagnosis: null,
    dependencyLevel: null,
    clinicalSpecialty: null,
    serviceType: null,
    documentType: null,
    documentNumber: null,
    sex: null,
    needsAttention: false,
    attentionReasons: [],
    addressesCount: 0,
    caseNumber: 766,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-06-01T00:00:00Z'),
  };

  describe('Cenário 10 — caseNumber incluso no payload', () => {
    it('deve incluir caseNumber no payload de cada paciente', async () => {
      mockList.mockResolvedValue({ rows: [baseRow], total: 1 });

      const [req, res] = mockReqResWithQuery({});
      await controller.listPatients(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      const jsonArg = (res as any).json.mock.calls[0][0];
      expect(jsonArg.data[0]).toHaveProperty('caseNumber', 766);
    });

    it('deve aceitar caseNumber null', async () => {
      mockList.mockResolvedValue({ rows: [{ ...baseRow, caseNumber: null }], total: 1 });

      const [req, res] = mockReqResWithQuery({});
      await controller.listPatients(req, res);

      const jsonArg = (res as any).json.mock.calls[0][0];
      expect(jsonArg.data[0].caseNumber).toBeNull();
    });
  });

  describe('Cenário 11 — filtro case_number válido', () => {
    it('deve aceitar case_number com dígitos e repassar ao repo', async () => {
      mockList.mockResolvedValue({ rows: [], total: 0 });

      const [req, res] = mockReqResWithQuery({ case_number: '766' });
      await controller.listPatients(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(mockList).toHaveBeenCalledWith(
        expect.objectContaining({ case_number: '766' }),
      );
    });
  });

  describe('Cenário 12 — filtro case_number inválido', () => {
    it('deve retornar 400 quando case_number contém letras', async () => {
      const [req, res] = mockReqResWithQuery({ case_number: 'abc' });
      await controller.listPatients(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect((res as any).json.mock.calls[0][0]).toMatchObject({
        success: false,
        error: 'Invalid query params',
      });
      expect(mockList).not.toHaveBeenCalled();
    });

    it('deve retornar 400 para case_number alfanumérico misto', async () => {
      const [req, res] = mockReqResWithQuery({ case_number: '12abc' });
      await controller.listPatients(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });
});
