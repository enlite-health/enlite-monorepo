/**
 * AdminPatientsController — bloco B (spec 012):
 *   PUT /:id/status v2: 403 quando o ator não pode ler texto clínico e manda onHoldNote (ponto único,
 *   D211.2); 422 com código de enum para transição proibida e ON_HOLD sem motivo; motivo/nota/origem
 *   viajam ao serviço; a nota NUNCA entra em log.
 *   GET /:id/status-history: 400 / 404 / 200 / 500.
 *   PATCH /:id/:section: 422 para código fora do catálogo (device_types / insurance_providers);
 *   trilha `patient_affiliate_id.write` SEM valor.
 */
const mockPoolQuery = jest.fn();
jest.mock('@shared/logging', () => ({
  reportError: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: jest.fn().mockReturnThis() },
}));
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({ query: mockPoolQuery, connect: jest.fn() }) }) },
}));
jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({ encrypt: jest.fn().mockResolvedValue('enc'), decrypt: jest.fn().mockResolvedValue(null) })),
}));
jest.mock('../../../infrastructure/PatientQueryRepository', () => ({
  PatientQueryRepository: jest.fn().mockImplementation(() => ({ findDetailById: jest.fn(), list: jest.fn(), stats: jest.fn() })),
}));
jest.mock('@modules/matching', () => ({ buildInsertQuery: jest.fn(), buildInsertParams: jest.fn() }));
jest.mock('../../../infrastructure/PatientStatusHistoryQueryHelper', () => ({ fetchPatientStatusHistory: jest.fn() }));

import { Request, Response } from 'express';
import { logger, reportError } from '@shared/logging';
import { AdminPatientsController } from '../AdminPatientsController';
import type { PatientService } from '../../../application/PatientService';
import { PatientStatusTransitionError, OnHoldReasonRequiredError } from '../../../application/PatientStatusWriter';
import { DeviceTypeUnknownError } from '../../../infrastructure/PatientDeviceTypeRepository';
import { InsuranceProviderUnknownError } from '../../../infrastructure/PatientInsuranceVerifiedRepository';
import { fetchPatientStatusHistory } from '../../../infrastructure/PatientStatusHistoryQueryHelper';
import type { CreatePatientUseCase } from '../../../application/CreatePatientUseCase';
import type { ActivatePatientUseCase } from '../../../application/ActivatePatientUseCase';

const ID = '11111111-1111-4111-8111-111111111111';
const NOTE = 'nota clinica que nao sai 8e2f';

function reqRes(params: Record<string, unknown>, body: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): [Request, Response] {
  const json = jest.fn().mockReturnThis();
  const status = jest.fn().mockReturnValue({ json });
  return [{ params, body, query: {}, ...extra } as unknown as Request, { json, status } as unknown as Response];
}
const bodyOf = (res: Response) => ((res as unknown as { status: jest.Mock }).status.mock.results[0].value.json as jest.Mock).mock.calls[0][0];

function makeController(svc: Partial<Record<'updatePatientSection' | 'moveStatus', jest.Mock>> = {}): AdminPatientsController {
  const patientService = { updatePatientSection: svc.updatePatientSection ?? jest.fn(), moveStatus: svc.moveStatus ?? jest.fn() } as unknown as PatientService;
  return new AdminPatientsController(undefined, { execute: jest.fn() } as unknown as CreatePatientUseCase, patientService, { execute: jest.fn() } as unknown as ActivatePatientUseCase);
}

describe('AdminPatientsController — bloco B', () => {
  beforeEach(() => { jest.clearAllMocks(); mockPoolQuery.mockResolvedValue({ rows: [{ id: ID }], rowCount: 1 }); });

  describe('PUT /:id/status v2', () => {
    it('ator sem célula que manda onHoldNote → 403 e o serviço não é chamado; sem nota passa', async () => {
      const moveStatus = jest.fn().mockResolvedValue({ id: ID, status: 'ON_HOLD' });
      const ctrl = makeController({ moveStatus });
      const [req, res] = reqRes({ id: ID }, { status: 'ON_HOLD', onHoldReason: 'SCHOOL', onHoldNote: NOTE }, { permissionCells: ['patient:write'] });
      await ctrl.updatePatientStatus(req, res);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(bodyOf(res).details).toEqual({ field: 'onHoldNote', cell: 'patient_clinical:read' });
      expect(moveStatus).not.toHaveBeenCalled();
      const [req2, res2] = reqRes({ id: ID }, { status: 'ON_HOLD', onHoldReason: 'SCHOOL' }, { permissionCells: ['patient:write'] });
      await ctrl.updatePatientStatus(req2, res2);
      expect(res2.status).toHaveBeenCalledWith(200);
    });

    it('C1: a guarda dispara pela CHAVE presente — `onHoldNote: null` de ator sem célula é 403 (apagar é escrever)', async () => {
      const moveStatus = jest.fn().mockResolvedValue({ id: ID, status: 'ON_HOLD' });
      const ctrl = makeController({ moveStatus });
      const [req, res] = reqRes({ id: ID }, { status: 'ON_HOLD', onHoldReason: 'SCHOOL', onHoldNote: null }, { permissionCells: ['patient:write'] });
      await ctrl.updatePatientStatus(req, res);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(moveStatus).not.toHaveBeenCalled();
    });

    it('C1: `onHoldNote: null` de quem PODE ler viaja como `null` (apagamento deliberado); chave ausente viaja como `undefined`', async () => {
      const moveStatus = jest.fn().mockResolvedValue({ id: ID, status: 'ON_HOLD' });
      const ctrl = makeController({ moveStatus });
      const [req, res] = reqRes({ id: ID }, { status: 'ON_HOLD', onHoldReason: 'SCHOOL', onHoldNote: null });
      await ctrl.updatePatientStatus(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(moveStatus.mock.calls[0][2]).toMatchObject({ onHoldNote: null });

      const [req2, res2] = reqRes({ id: ID }, { status: 'ON_HOLD', onHoldReason: 'SCHOOL' });
      await ctrl.updatePatientStatus(req2, res2);
      expect(res2.status).toHaveBeenCalledWith(200);
      expect(moveStatus.mock.calls[1][2].onHoldNote).toBeUndefined();
    });

    it('C1: corpo que não é objeto não quebra a guarda (o zod já recusou antes — 400)', async () => {
      const moveStatus = jest.fn();
      const ctrl = makeController({ moveStatus });
      const [req, res] = reqRes({ id: ID }, null as unknown as Record<string, unknown>, { permissionCells: [] });
      await ctrl.updatePatientStatus(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(moveStatus).not.toHaveBeenCalled();
    });

    it('motivo, nota e origem viajam ao serviço (defaults: admin_panel, null); a nota nunca vai ao log', async () => {
      const moveStatus = jest.fn().mockResolvedValue({ id: ID, status: 'ON_HOLD' });
      const ctrl = makeController({ moveStatus });
      const [req, res] = reqRes({ id: ID }, { status: 'ON_HOLD', onHoldReason: 'INSURER', onHoldNote: NOTE, changeSource: 'kanban' });
      await ctrl.updatePatientStatus(req, res);
      expect(moveStatus).toHaveBeenCalledWith(ID, 'ON_HOLD', { onHoldReason: 'INSURER', onHoldNote: NOTE, changeSource: 'kanban' });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(JSON.stringify((logger.info as jest.Mock).mock.calls)).not.toContain(NOTE);
      expect(JSON.stringify((reportError as jest.Mock).mock.calls)).not.toContain(NOTE);
    });

    it('transição proibida → 422 PATIENT_STATUS_TRANSITION_NOT_ALLOWED com from/to; ON_HOLD sem motivo → 422 ON_HOLD_REASON_REQUIRED', async () => {
      const moveStatus = jest.fn().mockRejectedValueOnce(new PatientStatusTransitionError('ACTIVE', 'SEARCHING')).mockRejectedValueOnce(new OnHoldReasonRequiredError());
      const ctrl = makeController({ moveStatus });
      const [req, res] = reqRes({ id: ID }, { status: 'SEARCHING' });
      await ctrl.updatePatientStatus(req, res);
      expect(res.status).toHaveBeenCalledWith(422);
      expect(bodyOf(res)).toMatchObject({ code: 'PATIENT_STATUS_TRANSITION_NOT_ALLOWED', details: { from: 'ACTIVE', to: 'SEARCHING' } });
      const [req2, res2] = reqRes({ id: ID }, { status: 'ON_HOLD' });
      await ctrl.updatePatientStatus(req2, res2);
      expect(res2.status).toHaveBeenCalledWith(422);
      expect(bodyOf(res2).code).toBe('ON_HOLD_REASON_REQUIRED');
      expect(reportError).not.toHaveBeenCalled();
    });

    it('body fora do schema (DISCONTINUED, changeSource estranho) → 400', async () => {
      const ctrl = makeController();
      const [req, res] = reqRes({ id: ID }, { status: 'DISCONTINUED' });
      await ctrl.updatePatientStatus(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      const [req2, res2] = reqRes({ id: ID }, { status: 'ACTIVE', changeSource: 'webhook' });
      await ctrl.updatePatientStatus(req2, res2);
      expect(res2.status).toHaveBeenCalledWith(400);
    });
  });

  describe('GET /:id/status-history', () => {
    it('400 id inválido; 404 paciente inexistente; 200 com history; 500 com reportError', async () => {
      const ctrl = makeController();
      const [r1, s1] = reqRes({ id: 'nope' });
      await ctrl.getPatientStatusHistory(r1, s1);
      expect(s1.status).toHaveBeenCalledWith(400);
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      const [r2, s2] = reqRes({ id: ID });
      await ctrl.getPatientStatusHistory(r2, s2);
      expect(s2.status).toHaveBeenCalledWith(404);
      (fetchPatientStatusHistory as jest.Mock).mockResolvedValueOnce([{ from: 'ACTIVE', to: 'ON_HOLD', source: 'admin_panel', at: new Date(0) }]);
      const [r3, s3] = reqRes({ id: ID });
      await ctrl.getPatientStatusHistory(r3, s3);
      expect(s3.status).toHaveBeenCalledWith(200);
      expect(bodyOf(s3)).toEqual({ success: true, data: { history: [{ from: 'ACTIVE', to: 'ON_HOLD', source: 'admin_panel', at: new Date(0) }] } });
      (fetchPatientStatusHistory as jest.Mock).mockRejectedValueOnce('boom');
      const [r4, s4] = reqRes({ id: ID });
      await ctrl.getPatientStatusHistory(r4, s4);
      expect(s4.status).toHaveBeenCalledWith(500);
      (fetchPatientStatusHistory as jest.Mock).mockRejectedValueOnce(new Error('db'));
      const [r5, s5] = reqRes({ id: ID });
      await ctrl.getPatientStatusHistory(r5, s5);
      expect(s5.status).toHaveBeenCalledWith(500);
      expect(reportError).toHaveBeenCalledWith(expect.any(Error), { source: 'AdminPatientsController:getPatientStatusHistory' });
    });
  });

  describe('PATCH /:id/:section', () => {
    it('código fora do catálogo → 422 com code e codes (device_types e insurance_providers)', async () => {
      const updatePatientSection = jest.fn().mockRejectedValueOnce(new DeviceTypeUnknownError(['CASA'])).mockRejectedValueOnce(new InsuranceProviderUnknownError(['XPTO']));
      const ctrl = makeController({ updatePatientSection });
      const [r1, s1] = reqRes({ id: ID, section: 'clinical' }, { deviceTypes: ['CASA'] });
      await ctrl.updatePatientSection(r1, s1);
      expect(s1.status).toHaveBeenCalledWith(422);
      expect(bodyOf(s1)).toMatchObject({ code: 'DEVICE_TYPE_UNKNOWN', details: { codes: ['CASA'] } });
      const [r2, s2] = reqRes({ id: ID, section: 'coverage' }, { insuranceVerifiedCodes: ['XPTO'] });
      await ctrl.updatePatientSection(r2, s2);
      expect(s2.status).toHaveBeenCalledWith(422);
      expect(bodyOf(s2)).toMatchObject({ code: 'INSURANCE_PROVIDER_UNKNOWN', details: { codes: ['XPTO'] } });
    });

    it('affiliateId presente (geral ou cobertura) → trilha patient_affiliate_id.write SEM o valor', async () => {
      const updatePatientSection = jest.fn().mockResolvedValue({ id: ID, updated: true });
      const ctrl = makeController({ updatePatientSection });
      const [r1, s1] = reqRes({ id: ID, section: 'coverage' }, { affiliateId: 'AF-SEGREDO-77' });
      await ctrl.updatePatientSection(r1, s1);
      expect(s1.status).toHaveBeenCalledWith(200);
      const trail = (logger.info as jest.Mock).mock.calls.find((c) => c[0].msg === 'patient_affiliate_id.write')?.[0];
      expect(trail).toEqual({ msg: 'patient_affiliate_id.write', uid: null, patientId: ID, section: 'coverage' });
      expect(JSON.stringify((logger.info as jest.Mock).mock.calls)).not.toContain('AF-SEGREDO-77');
      (logger.info as jest.Mock).mockClear();
      const [r2, s2] = reqRes({ id: ID, section: 'general' }, { firstName: 'Ana' });
      await ctrl.updatePatientSection(r2, s2);
      expect((logger.info as jest.Mock).mock.calls.some((c) => c[0].msg === 'patient_affiliate_id.write')).toBe(false);
    });
  });

  describe('catch com valor não-Error (ramo `instanceof` — a régua de 100% do arquivo tocado)', () => {
    it('updatePatientSection, createPatient, getPatientById e listPatientVacancies embrulham string em Error e devolvem 500', async () => {
      const updatePatientSection = jest.fn().mockRejectedValue('str');
      const ctrl = makeController({ updatePatientSection });
      const [r1, s1] = reqRes({ id: ID, section: 'general' }, { firstName: 'Ana' });
      await ctrl.updatePatientSection(r1, s1);
      expect(s1.status).toHaveBeenCalledWith(500);
      // createPatient / getPatientById / listPatientVacancies: os use cases/repos internos rejeitam com string
      const create = new AdminPatientsController(undefined, { execute: jest.fn().mockRejectedValue('str') } as unknown as CreatePatientUseCase, undefined, { execute: jest.fn() } as unknown as ActivatePatientUseCase);
      const [r2, s2] = reqRes({}, { firstName: 'Ana' });
      await create.createPatient(r2, s2);
      expect(s2.status).toHaveBeenCalledWith(500);
      const anyCtrl = ctrl as unknown as { getPatientByIdUseCase: { execute: jest.Mock } };
      anyCtrl.getPatientByIdUseCase = { execute: jest.fn().mockRejectedValue('str') };
      const [r3, s3] = reqRes({ id: ID });
      await ctrl.getPatientById(r3, s3);
      expect(s3.status).toHaveBeenCalledWith(500);
      mockPoolQuery.mockRejectedValueOnce('str');
      const [r4, s4] = reqRes({ id: ID });
      await ctrl.listPatientVacancies(r4, s4);
      expect(s4.status).toHaveBeenCalledWith(500);
      expect((reportError as jest.Mock).mock.calls.every((c) => c[0] instanceof Error)).toBe(true);
    });
  });
});
