/**
 * AdminPatientsController — Fase 2 Task 3 write/lifecycle endpoints.
 *
 * Covers:
 *   a. PATCH /:id/:section — each section calls updatePatientSection with the
 *      right (id, section, data); unknown section / bad body / missing patient
 *      are 400/400/404.
 *   b. PUT /:id/status — validates status (400 on unknown) and moves it (200).
 *   c. POST /:id/activate — 200 happy path, 422 no-address, 404 not-found.
 */

// ── Mocks (before importing the module under test) ────────────────────────────

const mockPoolQuery = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({ query: mockPoolQuery, connect: jest.fn() }),
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

// Keep the real matching barrel out of the controller test (ActivatePatientUseCase
// imports it at module load; we inject a stub use case so it never runs).
jest.mock('@modules/matching', () => ({
  buildInsertQuery: jest.fn(),
  buildInsertParams: jest.fn(),
}));

import { AdminPatientsController } from '../AdminPatientsController';
import {
  PatientNotFoundError,
  NoActiveAddressError,
} from '../../../application/ActivatePatientUseCase';
import type { CreatePatientUseCase } from '../../../application/CreatePatientUseCase';
import type { PatientService } from '../../../application/PatientService';
import type { ActivatePatientUseCase } from '../../../application/ActivatePatientUseCase';
import { Request, Response } from 'express';

// ── Helpers ────────────────────────────────────────────────────────────────────

function mockReqRes(
  params: Record<string, unknown> = {},
  body: Record<string, unknown> = {},
): [Request, Response] {
  const req = { params, query: {}, body } as unknown as Request;
  const json = jest.fn().mockReturnThis();
  const status = jest.fn().mockReturnValue({ json });
  const res = { json, status } as unknown as Response;
  return [req, res];
}

const VALID_ID = '11111111-1111-4111-8111-111111111111';

function makeController(opts: {
  updatePatientSection?: jest.Mock;
  moveStatus?: jest.Mock;
  activate?: jest.Mock;
}): AdminPatientsController {
  const patientService = {
    updatePatientSection: opts.updatePatientSection ?? jest.fn(),
    moveStatus: opts.moveStatus ?? jest.fn(),
  } as unknown as PatientService;
  const activateUseCase = { execute: opts.activate ?? jest.fn() } as unknown as ActivatePatientUseCase;
  const createUseCase = { execute: jest.fn() } as unknown as CreatePatientUseCase;
  return new AdminPatientsController(undefined, createUseCase, patientService, activateUseCase);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('AdminPatientsController — pipeline (Fase 2 Task 3)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // default: patient exists (existence check for PATCH section)
    mockPoolQuery.mockResolvedValue({ rows: [{ id: VALID_ID }], rowCount: 1 });
  });

  // ── a. PATCH /:id/:section ──────────────────────────────────────────────────

  describe('a. updatePatientSection', () => {
    it.each([
      ['general', { firstName: 'Ana', phoneWhatsapp: '+549110000000' }],
      ['clinical', { diagnosis: 'x', dependencyLevel: 'MILD' }],
      ['support-network', { responsibles: [{ firstName: 'R', lastName: 'One', isPrimary: true, displayOrder: 1 }] }],
      ['service', { serviceType: ['CAREGIVER'] }],
    ])('deve chamar updatePatientSection(%s) com o body validado e retornar 200', async (section, body) => {
      const updatePatientSection = jest.fn().mockResolvedValue({ id: VALID_ID, updated: true });
      const controller = makeController({ updatePatientSection });

      const [req, res] = mockReqRes({ id: VALID_ID, section }, body);
      await controller.updatePatientSection(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect((res as any).json).toHaveBeenCalledWith({ success: true, data: { id: VALID_ID } });
      expect(updatePatientSection).toHaveBeenCalledWith(VALID_ID, section, expect.objectContaining(body));
    });

    it('deve retornar 400 para section desconhecida (não chama o service)', async () => {
      const updatePatientSection = jest.fn();
      const controller = makeController({ updatePatientSection });

      const [req, res] = mockReqRes({ id: VALID_ID, section: 'financial' }, { foo: 1 });
      await controller.updatePatientSection(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(updatePatientSection).not.toHaveBeenCalled();
    });

    it('deve retornar 400 para campo fora do whitelist da seção (strict)', async () => {
      const updatePatientSection = jest.fn();
      const controller = makeController({ updatePatientSection });

      const [req, res] = mockReqRes({ id: VALID_ID, section: 'general' }, { notAField: 'x' });
      await controller.updatePatientSection(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(updatePatientSection).not.toHaveBeenCalled();
    });

    it('deve retornar 404 quando o paciente não existe', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      const updatePatientSection = jest.fn();
      const controller = makeController({ updatePatientSection });

      const [req, res] = mockReqRes({ id: VALID_ID, section: 'general' }, { firstName: 'Ana' });
      await controller.updatePatientSection(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(updatePatientSection).not.toHaveBeenCalled();
    });
  });

  // ── b. PUT /:id/status ──────────────────────────────────────────────────────

  describe('b. updatePatientStatus', () => {
    it('deve validar e mover o status, retornando 200 { id, status }', async () => {
      const moveStatus = jest.fn().mockResolvedValue({ id: VALID_ID, status: 'PENDING_ADMISSION' });
      const controller = makeController({ moveStatus });

      const [req, res] = mockReqRes({ id: VALID_ID }, { status: 'PENDING_ADMISSION' });
      await controller.updatePatientStatus(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect((res as any).json).toHaveBeenCalledWith({
        success: true,
        data: { id: VALID_ID, status: 'PENDING_ADMISSION' },
      });
      expect(moveStatus).toHaveBeenCalledWith(VALID_ID, 'PENDING_ADMISSION');
    });

    it('deve retornar 400 para status fora do vocabulário (não chama moveStatus)', async () => {
      const moveStatus = jest.fn();
      const controller = makeController({ moveStatus });

      const [req, res] = mockReqRes({ id: VALID_ID }, { status: 'NOT_A_STATUS' });
      await controller.updatePatientStatus(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(moveStatus).not.toHaveBeenCalled();
    });

    it('deve retornar 404 quando moveStatus reporta Patient not found', async () => {
      const moveStatus = jest.fn().mockRejectedValue(new Error('Patient not found: x'));
      const controller = makeController({ moveStatus });

      const [req, res] = mockReqRes({ id: VALID_ID }, { status: 'ACTIVE' });
      await controller.updatePatientStatus(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  // ── c. POST /:id/activate ───────────────────────────────────────────────────

  describe('c. activatePatient', () => {
    it('deve retornar 200 com { patientId, status, createdVacancyIds }', async () => {
      const activate = jest.fn().mockResolvedValue({
        patientId: VALID_ID,
        status: 'ACTIVE',
        createdVacancyIds: ['v1', 'v2'],
        alreadyActive: false,
      });
      const controller = makeController({ activate });

      const [req, res] = mockReqRes({ id: VALID_ID });
      await controller.activatePatient(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect((res as any).json).toHaveBeenCalledWith({
        success: true,
        data: { patientId: VALID_ID, status: 'ACTIVE', createdVacancyIds: ['v1', 'v2'] },
      });
    });

    it('deve retornar 422 quando o paciente não tem endereço ativo', async () => {
      const activate = jest.fn().mockRejectedValue(new NoActiveAddressError(VALID_ID));
      const controller = makeController({ activate });

      const [req, res] = mockReqRes({ id: VALID_ID });
      await controller.activatePatient(req, res);

      expect(res.status).toHaveBeenCalledWith(422);
      expect((res as any).json.mock.calls[0][0]).toMatchObject({ success: false });
    });

    it('deve retornar 404 quando o paciente não existe', async () => {
      const activate = jest.fn().mockRejectedValue(new PatientNotFoundError(VALID_ID));
      const controller = makeController({ activate });

      const [req, res] = mockReqRes({ id: VALID_ID });
      await controller.activatePatient(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('deve retornar 400 para id inválido', async () => {
      const activate = jest.fn();
      const controller = makeController({ activate });

      const [req, res] = mockReqRes({ id: 'not-a-uuid' });
      await controller.activatePatient(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(activate).not.toHaveBeenCalled();
    });
  });
});
