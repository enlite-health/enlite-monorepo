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

jest.mock('@shared/logging', () => ({
  reportError: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: jest.fn().mockReturnThis() },
}));

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

import { reportError } from '@shared/logging';
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
    it('C1 (D211.2): ator sem `patient_clinical:read` NÃO escreve emergencyInstructions → 403 e o service não é chamado; sem células (engine não decidiu) passa', async () => {
      const updatePatientSection = jest.fn().mockResolvedValue({ id: VALID_ID, updated: true });
      const controller = makeController({ updatePatientSection });
      const [req, res] = mockReqRes({ id: VALID_ID, section: 'clinical' }, { emergencyInstructions: 'Llamar 107' });
      (req as unknown as { permissionCells: string[] }).permissionCells = ['patient:write'];
      await controller.updatePatientSection(req, res);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(updatePatientSection).not.toHaveBeenCalled();
      // outro campo clínico com as mesmas células passa (a trava é do campo restrito)
      const [req2, res2] = mockReqRes({ id: VALID_ID, section: 'clinical' }, { deviceTypes: ['HOME'] });
      (req2 as unknown as { permissionCells: string[] }).permissionCells = ['patient:write'];
      await controller.updatePatientSection(req2, res2);
      expect(res2.status).not.toHaveBeenCalledWith(403);
    });

    it('417 / D301: emergencyContacts exige `patient_coverage:read` (quem não lê não escreve); DIRECT_PROFESSIONAL exige também `patient_care_team:read`; as células vão ao service', async () => {
      const updatePatientSection = jest.fn().mockResolvedValue({ id: VALID_ID, updated: true });
      const controller = makeController({ updatePatientSection });
      const ambulancia = { emergencyContacts: [{ kind: 'AMBULANCE', name: 'A', phone: '1' }] };
      const profissional = { emergencyContacts: [{ kind: 'DIRECT_PROFESSIONAL', name: 'Dra.', phone: '1' }] };
      // Só write, sem read da cobertura → 403 nomeando a célula de leitura.
      const [r1, s1] = mockReqRes({ id: VALID_ID, section: 'coverage' }, ambulancia);
      (r1 as unknown as { permissionCells: string[] }).permissionCells = ['patient_coverage:write'];
      await controller.updatePatientSection(r1, s1);
      expect(s1.status).toHaveBeenCalledWith(403);
      expect(s1.json).toHaveBeenCalledWith(expect.objectContaining({ details: { field: 'emergencyContacts', cell: 'patient_coverage:read' } }));
      // Cobertura r/w sem equipe: ambulância passa; profissional direto → 403 nomeando a célula da equipe.
      const [r2, s2] = mockReqRes({ id: VALID_ID, section: 'coverage' }, ambulancia);
      (r2 as unknown as { permissionCells: string[] }).permissionCells = ['patient_coverage:read', 'patient_coverage:write'];
      (r2 as unknown as { authContext: unknown }).authContext = { principal: { id: 'uid-staff-1' } };
      await controller.updatePatientSection(r2, s2);
      expect(s2.status).not.toHaveBeenCalledWith(403);
      expect(updatePatientSection).toHaveBeenLastCalledWith(VALID_ID, 'coverage', ambulancia, { uid: 'uid-staff-1', cells: ['patient_coverage:read', 'patient_coverage:write'] });
      const [r3, s3] = mockReqRes({ id: VALID_ID, section: 'coverage' }, profissional);
      (r3 as unknown as { permissionCells: string[] }).permissionCells = ['patient_coverage:read', 'patient_coverage:write'];
      await controller.updatePatientSection(r3, s3);
      expect(s3.status).toHaveBeenCalledWith(403);
      expect(s3.json).toHaveBeenCalledWith(expect.objectContaining({ details: { field: 'emergencyContacts', cell: 'patient_care_team:read' } }));
      // Com a equipe também: passa. Sem células (engine não decidiu): passa.
      const [r4, s4] = mockReqRes({ id: VALID_ID, section: 'coverage' }, profissional);
      (r4 as unknown as { permissionCells: string[] }).permissionCells = ['patient_coverage:read', 'patient_coverage:write', 'patient_care_team:read'];
      await controller.updatePatientSection(r4, s4);
      expect(s4.status).not.toHaveBeenCalledWith(403);
      const [r5, s5] = mockReqRes({ id: VALID_ID, section: 'coverage' }, profissional);
      await controller.updatePatientSection(r5, s5);
      expect(s5.status).not.toHaveBeenCalledWith(403);
    });

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
      // 4º arg = actor (autoria, REQ-01): sem auth no request mockado vai undefined.
      expect(updatePatientSection).toHaveBeenCalledWith(VALID_ID, section, expect.objectContaining(body), undefined);
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

  // ── a2. autoria (REQ-01 · D195 · lex item 3) ──────────────────────────────
  describe('a2. autoria do PATCH', () => {
    const CLINICAL_TEXT = 'Paciente con TEA nivel 2; evitar ruidos fuertes; crisis: llamar a la madre.';

    it('passa o uid do staff autenticado como 4º argumento (actor)', async () => {
      const updatePatientSection = jest.fn().mockResolvedValue({ id: VALID_ID, updated: true });
      const controller = makeController({ updatePatientSection });
      const [req, res] = mockReqRes({ id: VALID_ID, section: 'clinical' }, { additionalComments: CLINICAL_TEXT });
      (req as unknown as { authContext: unknown }).authContext = { principal: { id: 'uid-staff-1' } };

      await controller.updatePatientSection(req, res);

      expect(updatePatientSection).toHaveBeenCalledWith(VALID_ID, 'clinical', expect.objectContaining({ additionalComments: CLINICAL_TEXT }), { uid: 'uid-staff-1', cells: null }); // 417: as células vão junto (engine não decidiu → null)
    });

    it('sem contexto de auth, actor é undefined (o repositório não grava autoria)', async () => {
      const updatePatientSection = jest.fn().mockResolvedValue({ id: VALID_ID, updated: true });
      const controller = makeController({ updatePatientSection });
      const [req, res] = mockReqRes({ id: VALID_ID, section: 'clinical' }, { additionalComments: CLINICAL_TEXT });

      await controller.updatePatientSection(req, res);

      expect(updatePatientSection.mock.calls[0][3]).toBeUndefined();
    });

    // lex C1.2: o texto clínico NUNCA vai para log/telemetria. Régua: o payload do
    // reportError não contém o texto. Controle positivo abaixo prova que a régua
    // detecta um vazamento — sem ele, "não contém" poderia ser "não olhei".
    const contemTexto = (v: unknown): boolean => JSON.stringify(v).includes(CLINICAL_TEXT);

    it('falha do service: reportError NÃO leva o texto clínico (só section)', async () => {
      const updatePatientSection = jest.fn().mockRejectedValue(new Error('db down'));
      const controller = makeController({ updatePatientSection });
      const [req, res] = mockReqRes({ id: VALID_ID, section: 'clinical' }, { additionalComments: CLINICAL_TEXT });

      await controller.updatePatientSection(req, res);

      expect(reportError).toHaveBeenCalledTimes(1);
      const [err, meta] = (reportError as jest.Mock).mock.calls[0];
      expect(contemTexto(meta)).toBe(false);
      expect(contemTexto((err as Error).message)).toBe(false);
      expect(meta).toEqual({ source: 'AdminPatientsController:updatePatientSection', section: 'clinical' });
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('controle positivo: a régua acusa quando o texto aparece no metadado', () => {
      expect(contemTexto({ source: 'x', body: { additionalComments: CLINICAL_TEXT } })).toBe(true);
    });
  });

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
      // v2 (spec 012): motivo/nota/origem viajam num 3º argumento. `onHoldNote: undefined`
      // (chave AUSENTE no corpo) = "não toque na coluna" — `null` ali APAGARIA a nota clínica.
      expect(moveStatus).toHaveBeenCalledWith(VALID_ID, 'PENDING_ADMISSION', { onHoldReason: null, onHoldNote: undefined, changeSource: 'admin_panel' });
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
