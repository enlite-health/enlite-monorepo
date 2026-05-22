/**
 * AdminPatientsController.test.ts — getPatientById
 *
 * Cenários:
 *   1. Happy path — paciente encontrado → 200 { success: true, data }
 *   2. Not found — use case retorna found:false → 404
 *   3. UUID inválido nos params → 400
 *   4. Erro interno no use case → 500
 *   5. Paciente sem responsáveis/endereços/profissionais → 200 com arrays vazios
 */

// ─── Mocks (antes de qualquer import do módulo) ───────────────────────────────

const mockFindDetailById = jest.fn();

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

// Mock PatientQueryRepository so findDetailById is controlled
jest.mock('../../../infrastructure/PatientQueryRepository', () => ({
  PatientQueryRepository: jest.fn().mockImplementation(() => ({
    findDetailById: mockFindDetailById,
    list: jest.fn(),
    stats: jest.fn(),
  })),
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
    healthInsurance: {
      providerName: 'OSDE',
      plan: null,
      memberId: null,
      emergencyNumbers: [],
      source: 'clickup' as const,
    },
    province: 'Buenos Aires',
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
