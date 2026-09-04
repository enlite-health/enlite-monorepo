/**
 * AdminPatientDiagnosesController — Facade mockada (a prova end-to-end de SQL real + mcp_ro
 * negado + concorrência é o e2e tests/e2e/patient-diagnoses.e2e.test.ts). Molde:
 * AdminPatientContractedServicesController.test.ts.
 */
jest.mock('@modules/identity', () => ({ AuthMiddleware: { getAuthContext: jest.fn() } }));
jest.mock('@shared/logging', () => ({ reportError: jest.fn() }));

import { AdminPatientDiagnosesController } from '../AdminPatientDiagnosesController';
import { AuthMiddleware } from '@modules/identity';
import { TerminologyUnavailableError } from '../../../../terminology/domain/UnavailableTerminology';
import { IcdCode } from '../../../../terminology/domain/IcdCode';
import { DiagnosisSource } from '../../../domain/DiagnosisSource';
import { PatientDiagnosis } from '../../../domain/PatientDiagnosis';
import type { Response } from 'express';
import type { PatientDiagnosisService } from '../../../application/PatientDiagnosisService';

const PATIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const DIAGNOSIS_ID = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';

function mockReq(overrides: Record<string, unknown> = {}) {
  return { params: {}, body: {}, ...overrides } as never;
}
function mockRes(): Response & { status: jest.Mock; json: jest.Mock } {
  const res: { status: jest.Mock; json: jest.Mock } = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as unknown as Response & { status: jest.Mock; json: jest.Mock };
}

function aDiagnosis(overrides: Partial<Parameters<typeof PatientDiagnosis.reconstruct>[0]> = {}) {
  return PatientDiagnosis.reconstruct({
    id: DIAGNOSIS_ID,
    patientId: PATIENT_ID,
    terminologySystem: 'ICD-11',
    conceptUri: 'http://id.who.int/icd/release/11/2026-01/mms/6A02',
    conceptCode: IcdCode.parse('6A02.Z'),
    conceptTitle: 'Trastorno del espectro autista',
    conceptLanguage: 'es',
    conceptGroup: '06',
    catalogRelease: '2026-01',
    source: DiagnosisSource.PANEL,
    isPrimary: false,
    active: true,
    endedAt: null,
    country: 'AR',
    createdBy: 'uid-1',
    updatedBy: 'uid-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
}

describe('AdminPatientDiagnosesController (spec 016 F2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (AuthMiddleware.getAuthContext as jest.Mock).mockReturnValue({ principal: { id: 'uid-1' } });
  });

  it('constrói com o serviço DEFAULT (Postgres + porta real) sem erro — só monta objetos, não faz I/O', () => {
    expect(() => new AdminPatientDiagnosesController()).not.toThrow();
  });

  describe('list', () => {
    it('400 quando :id não é UUID', async () => {
      const service = { listForPatient: jest.fn() };
      const controller = new AdminPatientDiagnosesController(service as unknown as PatientDiagnosisService);
      const res = mockRes();
      await controller.list(mockReq({ params: { id: 'x' } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(service.listForPatient).not.toHaveBeenCalled();
    });

    it('404 quando o paciente não existe', async () => {
      const service = { listForPatient: jest.fn().mockResolvedValue({ found: false }) };
      const controller = new AdminPatientDiagnosesController(service as unknown as PatientDiagnosisService);
      const res = mockRes();
      await controller.list(mockReq({ params: { id: PATIENT_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('200 com diagnoses[] projetado por DiagnosisPublicView — nenhuma chave de código', async () => {
      const service = { listForPatient: jest.fn().mockResolvedValue({ found: true, diagnoses: [aDiagnosis()] }) };
      const controller = new AdminPatientDiagnosesController(service as unknown as PatientDiagnosisService);
      const res = mockRes();
      await controller.list(mockReq({ params: { id: PATIENT_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(200);
      const [payload] = res.json.mock.calls[0];
      expect(payload.data.diagnoses[0]).toEqual({
        id: DIAGNOSIS_ID, uri: aDiagnosis().conceptUri, title: 'Trastorno del espectro autista',
        isPrimary: false, source: 'PANEL', active: true,
      });
      expect(Object.keys(payload.data.diagnoses[0])).not.toEqual(expect.arrayContaining(['code', 'chapter', 'release']));
    });

    it('500 quando o serviço lança', async () => {
      const service = { listForPatient: jest.fn().mockRejectedValue(new Error('boom')) };
      const controller = new AdminPatientDiagnosesController(service as unknown as PatientDiagnosisService);
      const res = mockRes();
      await controller.list(mockReq({ params: { id: PATIENT_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('500 quando o serviço rejeita com algo que NÃO é Error (String(err) no reportError)', async () => {
      const service = { listForPatient: jest.fn().mockRejectedValue('rejeição crua') };
      const controller = new AdminPatientDiagnosesController(service as unknown as PatientDiagnosisService);
      const res = mockRes();
      await controller.list(mockReq({ params: { id: PATIENT_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('sem contexto de auth (getAuthContext devolve undefined) não impede a leitura — actorUid não entra em list', async () => {
      (AuthMiddleware.getAuthContext as jest.Mock).mockReturnValue(undefined);
      const service = { listForPatient: jest.fn().mockResolvedValue({ found: true, diagnoses: [] }) };
      const controller = new AdminPatientDiagnosesController(service as unknown as PatientDiagnosisService);
      const res = mockRes();
      await controller.list(mockReq({ params: { id: PATIENT_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  describe('create', () => {
    it('400 quando :id não é UUID', async () => {
      const service = { recordDiagnosis: jest.fn() };
      const controller = new AdminPatientDiagnosesController(service as unknown as PatientDiagnosisService);
      const res = mockRes();
      await controller.create(mockReq({ params: { id: 'x' } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('400 quando o body não tem conceptUri', async () => {
      const service = { recordDiagnosis: jest.fn() };
      const controller = new AdminPatientDiagnosesController(service as unknown as PatientDiagnosisService);
      const res = mockRes();
      await controller.create(mockReq({ params: { id: PATIENT_ID }, body: {} }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(service.recordDiagnosis).not.toHaveBeenCalled();
    });

    it('404 quando o paciente não existe (outcome patient_not_found)', async () => {
      const service = { recordDiagnosis: jest.fn().mockResolvedValue({ outcome: 'patient_not_found' }) };
      const controller = new AdminPatientDiagnosesController(service as unknown as PatientDiagnosisService);
      const res = mockRes();
      await controller.create(mockReq({ params: { id: PATIENT_ID }, body: { conceptUri: 'http://x' } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('422 quando a URI não resolve (outcome concept_not_resolved)', async () => {
      const service = { recordDiagnosis: jest.fn().mockResolvedValue({ outcome: 'concept_not_resolved' }) };
      const controller = new AdminPatientDiagnosesController(service as unknown as PatientDiagnosisService);
      const res = mockRes();
      await controller.create(mockReq({ params: { id: PATIENT_ID }, body: { conceptUri: 'http://x' } }), res);
      expect(res.status).toHaveBeenCalledWith(422);
    });

    it('409 quando o conceito já está ativo nesta origem (outcome already_active)', async () => {
      const service = { recordDiagnosis: jest.fn().mockResolvedValue({ outcome: 'already_active', diagnosis: aDiagnosis() }) };
      const controller = new AdminPatientDiagnosesController(service as unknown as PatientDiagnosisService);
      const res = mockRes();
      await controller.create(mockReq({ params: { id: PATIENT_ID }, body: { conceptUri: 'http://x' } }), res);
      expect(res.status).toHaveBeenCalledWith(409);
    });

    it('C3 (QA-caça) — 422 quando a URI é capítulo/extensão (outcome not_diagnosable); a mensagem NÃO ecoa o concept_code', async () => {
      const service = { recordDiagnosis: jest.fn().mockResolvedValue({ outcome: 'not_diagnosable' }) };
      const controller = new AdminPatientDiagnosesController(service as unknown as PatientDiagnosisService);
      const res = mockRes();
      await controller.create(mockReq({ params: { id: PATIENT_ID }, body: { conceptUri: 'http://x' } }), res);
      expect(res.status).toHaveBeenCalledWith(422);
      const [payload] = res.json.mock.calls[0];
      expect(payload.code).toBe('CONCEPT_NOT_DIAGNOSABLE');
      expect(JSON.stringify(payload)).not.toMatch(/6A02|XM0ZH6/);
    });

    it('C1 (QA-caça) — 409 quando o 23505 do índice de principal escapa (outcome primary_race), NUNCA 500', async () => {
      const service = { recordDiagnosis: jest.fn().mockResolvedValue({ outcome: 'primary_race' }) };
      const controller = new AdminPatientDiagnosesController(service as unknown as PatientDiagnosisService);
      const res = mockRes();
      await controller.create(mockReq({ params: { id: PATIENT_ID }, body: { conceptUri: 'http://x', isPrimary: true } }), res);
      expect(res.status).toHaveBeenCalledWith(409);
      const [payload] = res.json.mock.calls[0];
      expect(payload.code).toBe('PRIMARY_DIAGNOSIS_RACE');
    });

    it('201 com a Entity criada, projetada (outcome created)', async () => {
      const service = { recordDiagnosis: jest.fn().mockResolvedValue({ outcome: 'created', diagnosis: aDiagnosis() }) };
      const controller = new AdminPatientDiagnosesController(service as unknown as PatientDiagnosisService);
      const res = mockRes();
      await controller.create(mockReq({ params: { id: PATIENT_ID }, body: { conceptUri: 'http://x', isPrimary: true } }), res);
      expect(res.status).toHaveBeenCalledWith(201);
      expect(service.recordDiagnosis).toHaveBeenCalledWith({ patientId: PATIENT_ID, conceptUri: 'http://x', isPrimary: true, actorUid: 'uid-1' });
    });

    it('503 quando a porta está indisponível (US-4 — falha VISÍVEL, nunca 500 genérico)', async () => {
      const service = { recordDiagnosis: jest.fn().mockRejectedValue(new TerminologyUnavailableError('teste')) };
      const controller = new AdminPatientDiagnosesController(service as unknown as PatientDiagnosisService);
      const res = mockRes();
      await controller.create(mockReq({ params: { id: PATIENT_ID }, body: { conceptUri: 'http://x' } }), res);
      expect(res.status).toHaveBeenCalledWith(503);
    });

    it('500 quando o serviço lança um erro genérico', async () => {
      const service = { recordDiagnosis: jest.fn().mockRejectedValue(new Error('boom')) };
      const controller = new AdminPatientDiagnosesController(service as unknown as PatientDiagnosisService);
      const res = mockRes();
      await controller.create(mockReq({ params: { id: PATIENT_ID }, body: { conceptUri: 'http://x' } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('500 quando o serviço rejeita com algo que NÃO é Error', async () => {
      const service = { recordDiagnosis: jest.fn().mockRejectedValue('rejeição crua') };
      const controller = new AdminPatientDiagnosesController(service as unknown as PatientDiagnosisService);
      const res = mockRes();
      await controller.create(mockReq({ params: { id: PATIENT_ID }, body: { conceptUri: 'http://x' } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('sem contexto de auth: actorUid cai para "unknown" (nunca lança)', async () => {
      (AuthMiddleware.getAuthContext as jest.Mock).mockReturnValue(undefined);
      const service = { recordDiagnosis: jest.fn().mockResolvedValue({ outcome: 'created', diagnosis: aDiagnosis() }) };
      const controller = new AdminPatientDiagnosesController(service as unknown as PatientDiagnosisService);
      const res = mockRes();
      await controller.create(mockReq({ params: { id: PATIENT_ID }, body: { conceptUri: 'http://x' } }), res);
      expect(service.recordDiagnosis).toHaveBeenCalledWith(expect.objectContaining({ actorUid: 'unknown' }));
    });
  });

  describe('update', () => {
    it('400 quando :did não é UUID', async () => {
      const service = { setPrimary: jest.fn(), deactivate: jest.fn() };
      const controller = new AdminPatientDiagnosesController(service as unknown as PatientDiagnosisService);
      const res = mockRes();
      await controller.update(mockReq({ params: { id: PATIENT_ID, did: 'x' } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('400 quando o body não tem isPrimary nem active', async () => {
      const service = { setPrimary: jest.fn(), deactivate: jest.fn() };
      const controller = new AdminPatientDiagnosesController(service as unknown as PatientDiagnosisService);
      const res = mockRes();
      await controller.update(mockReq({ params: { id: PATIENT_ID, did: DIAGNOSIS_ID }, body: {} }), res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('isPrimary=true delega a setPrimary; 200 na Entity projetada', async () => {
      const service = { setPrimary: jest.fn().mockResolvedValue({ outcome: 'ok', diagnosis: aDiagnosis({ isPrimary: true }) }), deactivate: jest.fn() };
      const controller = new AdminPatientDiagnosesController(service as unknown as PatientDiagnosisService);
      const res = mockRes();
      await controller.update(mockReq({ params: { id: PATIENT_ID, did: DIAGNOSIS_ID }, body: { isPrimary: true } }), res);
      expect(service.setPrimary).toHaveBeenCalledWith(PATIENT_ID, DIAGNOSIS_ID, 'uid-1');
      expect(service.deactivate).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('active=false delega a deactivate; 200 na Entity projetada', async () => {
      const service = { setPrimary: jest.fn(), deactivate: jest.fn().mockResolvedValue({ outcome: 'ok', diagnosis: aDiagnosis({ active: false, isPrimary: false, endedAt: new Date() }) }) };
      const controller = new AdminPatientDiagnosesController(service as unknown as PatientDiagnosisService);
      const res = mockRes();
      await controller.update(mockReq({ params: { id: PATIENT_ID, did: DIAGNOSIS_ID }, body: { active: false } }), res);
      expect(service.deactivate).toHaveBeenCalledWith(PATIENT_ID, DIAGNOSIS_ID, 'uid-1');
      expect(service.setPrimary).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('404 quando o outcome é not_found (id inexistente OU cross-patient OU outra origem)', async () => {
      const service = { setPrimary: jest.fn().mockResolvedValue({ outcome: 'not_found' }), deactivate: jest.fn() };
      const controller = new AdminPatientDiagnosesController(service as unknown as PatientDiagnosisService);
      const res = mockRes();
      await controller.update(mockReq({ params: { id: PATIENT_ID, did: DIAGNOSIS_ID }, body: { isPrimary: true } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('409 quando o outcome é conflict (reason=already_inactive)', async () => {
      const service = { setPrimary: jest.fn(), deactivate: jest.fn().mockResolvedValue({ outcome: 'conflict', reason: 'already_inactive' }) };
      const controller = new AdminPatientDiagnosesController(service as unknown as PatientDiagnosisService);
      const res = mockRes();
      await controller.update(mockReq({ params: { id: PATIENT_ID, did: DIAGNOSIS_ID }, body: { active: false } }), res);
      expect(res.status).toHaveBeenCalledWith(409);
      const [payload] = res.json.mock.calls[0];
      expect(payload.code).toBe('DIAGNOSIS_NOT_ACTIVE');
    });

    it('C1 (QA-caça) — 409 com code PRIMARY_DIAGNOSIS_RACE quando o outcome é conflict/primary_race, NUNCA 500', async () => {
      const service = { setPrimary: jest.fn().mockResolvedValue({ outcome: 'conflict', reason: 'primary_race' }), deactivate: jest.fn() };
      const controller = new AdminPatientDiagnosesController(service as unknown as PatientDiagnosisService);
      const res = mockRes();
      await controller.update(mockReq({ params: { id: PATIENT_ID, did: DIAGNOSIS_ID }, body: { isPrimary: true } }), res);
      expect(res.status).toHaveBeenCalledWith(409);
      const [payload] = res.json.mock.calls[0];
      expect(payload.code).toBe('PRIMARY_DIAGNOSIS_RACE');
    });

    it('500 quando o serviço lança', async () => {
      const service = { setPrimary: jest.fn().mockRejectedValue(new Error('boom')), deactivate: jest.fn() };
      const controller = new AdminPatientDiagnosesController(service as unknown as PatientDiagnosisService);
      const res = mockRes();
      await controller.update(mockReq({ params: { id: PATIENT_ID, did: DIAGNOSIS_ID }, body: { isPrimary: true } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('500 quando o serviço rejeita com algo que NÃO é Error', async () => {
      const service = { setPrimary: jest.fn().mockRejectedValue('rejeição crua'), deactivate: jest.fn() };
      const controller = new AdminPatientDiagnosesController(service as unknown as PatientDiagnosisService);
      const res = mockRes();
      await controller.update(mockReq({ params: { id: PATIENT_ID, did: DIAGNOSIS_ID }, body: { isPrimary: true } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });
});
