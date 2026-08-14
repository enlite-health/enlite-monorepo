/**
 * AdminPatientsController.createPatient (POST /api/admin/patients) — Fase 1 Task 2.
 *
 * Covers:
 *   1. Happy path — 201 { success, data:{ id } }, use-case called with mapped input
 *   2. Missing firstName — 400 Invalid body, use-case NOT called
 *   3. Invalid contactEmail — 400 Invalid body
 *   4. Contact invariant fails — 400 (PatientContactValidationError), NOT 500
 *   5. Unexpected error — 500 Failed to create patient
 */

// ─── Mocks (before importing the module under test) ───────────────────────────

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

jest.mock('../../../infrastructure/PatientQueryRepository', () => ({
  PatientQueryRepository: jest.fn().mockImplementation(() => ({
    findDetailById: jest.fn(),
    list: jest.fn(),
    stats: jest.fn(),
  })),
}));

import { AdminPatientsController } from '../AdminPatientsController';
import {
  CreatePatientUseCase,
  PatientContactValidationError,
} from '../../../application/CreatePatientUseCase';
import { Request, Response } from 'express';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockReqRes(body: Record<string, unknown> = {}): [Request, Response] {
  const req = { params: {}, query: {}, body } as unknown as Request;
  const json = jest.fn().mockReturnThis();
  const status = jest.fn().mockReturnValue({ json });
  const res = { json, status } as unknown as Response;
  return [req, res];
}

function makeController(execute: jest.Mock): AdminPatientsController {
  const stubUseCase = { execute } as unknown as CreatePatientUseCase;
  return new AdminPatientsController(undefined, stubUseCase);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AdminPatientsController.createPatient', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('Cenário 1 — Happy path', () => {
    it('deve retornar 201 com { success, data:{ id } } e mapear o body ao use-case', async () => {
      const execute = jest.fn().mockResolvedValue({ id: 'pat-001' });
      const controller = makeController(execute);

      const body = {
        firstName: 'Juan',
        country: 'AR',
        lastName: 'Pérez',
        phoneWhatsapp: '+5491100000000',
        contactEmail: 'juan@example.com',
        documentType: 'DNI',
        documentNumber: '12345678',
        healthInsuranceName: 'OSDE',
        healthInsuranceMemberId: 'A-9',
        serviceType: ['CAREGIVER', 'NURSE'],
      };
      const [req, res] = mockReqRes(body);
      await controller.createPatient(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect((res as any).json).toHaveBeenCalledWith({ success: true, data: { id: 'pat-001' } });
      expect(execute).toHaveBeenCalledWith(expect.objectContaining(body));
    });

    it('deve aceitar apenas firstName + country (demais campos opcionais)', async () => {
      const execute = jest.fn().mockResolvedValue({ id: 'pat-002' });
      const controller = makeController(execute);

      const [req, res] = mockReqRes({ firstName: 'Ana', country: 'AR' });
      await controller.createPatient(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ firstName: 'Ana', country: 'AR' }),
      );
    });

    it('deve repassar country=BR ao use-case sem trocar por AR', async () => {
      const execute = jest.fn().mockResolvedValue({ id: 'pat-003' });
      const controller = makeController(execute);

      const [req, res] = mockReqRes({ firstName: 'João', country: 'BR' });
      await controller.createPatient(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(execute).toHaveBeenCalledWith(expect.objectContaining({ country: 'BR' }));
    });
  });

  describe('Cenário 2 — firstName ausente', () => {
    it('deve retornar 400 Invalid body e NÃO chamar o use-case', async () => {
      const execute = jest.fn();
      const controller = makeController(execute);

      const [req, res] = mockReqRes({ lastName: 'Pérez', country: 'AR' });
      await controller.createPatient(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect((res as any).json.mock.calls[0][0]).toMatchObject({
        success: false,
        error: 'Invalid body',
      });
      expect(execute).not.toHaveBeenCalled();
    });
  });

  // abac-pais-fase1 task 5.1 — the admin create path used to hardcode 'AR' at
  // the use-case edge. A body with no country must now 400 visibly instead of
  // silently persisting a possibly-BR patient as AR (spec country-isolation).
  describe('Cenário 2b — country ausente ou inválido', () => {
    it('deve retornar 400 Invalid body quando country falta, e NÃO chamar o use-case', async () => {
      const execute = jest.fn();
      const controller = makeController(execute);

      const [req, res] = mockReqRes({ firstName: 'Juan' });
      await controller.createPatient(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      const payload = (res as any).json.mock.calls[0][0];
      expect(payload).toMatchObject({ success: false, error: 'Invalid body' });
      expect(payload.details.fieldErrors.country).toEqual([
        'country is required and must be one of AR, BR',
      ]);
      expect(execute).not.toHaveBeenCalled();
    });

    it('deve retornar 400 para um country fora de AR|BR', async () => {
      const execute = jest.fn();
      const controller = makeController(execute);

      const [req, res] = mockReqRes({ firstName: 'Juan', country: 'UY' });
      await controller.createPatient(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(execute).not.toHaveBeenCalled();
    });
  });

  describe('Cenário 3 — contactEmail inválido', () => {
    it('deve retornar 400 quando contactEmail não é email', async () => {
      const execute = jest.fn();
      const controller = makeController(execute);

      const [req, res] = mockReqRes({
        firstName: 'Juan',
        country: 'AR',
        contactEmail: 'not-an-email',
      });
      await controller.createPatient(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(execute).not.toHaveBeenCalled();
    });

    it('deve retornar 400 quando serviceType tem valor fora do vocabulário', async () => {
      const execute = jest.fn();
      const controller = makeController(execute);

      const [req, res] = mockReqRes({
        firstName: 'Juan',
        country: 'AR',
        serviceType: ['NOT_A_ROLE'],
      });
      await controller.createPatient(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(execute).not.toHaveBeenCalled();
    });
  });

  describe('Cenário 4 — Invariante de contato falha', () => {
    it('deve retornar 400 (não 500) quando o use-case lança PatientContactValidationError', async () => {
      const execute = jest
        .fn()
        .mockRejectedValue(new PatientContactValidationError('Validação de contato: falta canal'));
      const controller = makeController(execute);

      const [req, res] = mockReqRes({ firstName: 'Juan', country: 'AR' });
      await controller.createPatient(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect((res as any).json.mock.calls[0][0]).toMatchObject({
        success: false,
        error: 'Validação de contato: falta canal',
      });
    });
  });

  describe('Cenário 5 — Erro inesperado', () => {
    it('deve retornar 500 quando o use-case lança erro genérico', async () => {
      const execute = jest.fn().mockRejectedValue(new Error('DB down'));
      const controller = makeController(execute);

      const [req, res] = mockReqRes({ firstName: 'Juan', country: 'AR' });
      await controller.createPatient(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect((res as any).json.mock.calls[0][0]).toMatchObject({
        success: false,
        error: 'Failed to create patient',
        details: 'DB down',
      });
    });
  });
});
