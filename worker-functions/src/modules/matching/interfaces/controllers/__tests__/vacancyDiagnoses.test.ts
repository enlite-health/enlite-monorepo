/**
 * CID-11 na vacante (D286/D263) — `diagnoses[]`/`diagnosesUnavailable` embutidos em
 * `GET /vacancies/:id` e `GET /recruitment/case/:caseNumber`, lidos por uma SEGUNDA chamada
 * (`loadVacancyPatientDiagnoses` → `PatientDiagnosisService`), nunca por `JOIN patient_diagnoses`
 * na query principal — guarda disso é `__tests__/diagnosticoForaDaVaga.test.ts` (não este arquivo).
 *
 * Este arquivo testa a SEMÂNTICA dos dois campos (as três hipóteses nunca se confundem):
 *  · com `patient_clinical:read`     → diagnoses[] projetado (REQ-21: sem code/group/release)
 *  · sem `patient_clinical:read`     → diagnoses === null (nunca [])
 *  · repositório lança               → diagnosesUnavailable === true, HTTP ainda 200
 *  · vaga/caso sem patient_id        → diagnoses === [], diagnosesUnavailable === false
 */

const mockQuery = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({ query: mockQuery }),
    }),
  },
}));

import { Request, Response } from 'express';
import { VacanciesController } from '../VacanciesController';
import { RecruitmentAnalyticsController } from '../RecruitmentAnalyticsController';
import { PatientDiagnosisService } from '@modules/diagnosis/application/PatientDiagnosisService';
import { PatientDiagnosis } from '@modules/diagnosis/domain/PatientDiagnosis';
import { DiagnosisSource } from '@modules/diagnosis/domain/DiagnosisSource';
import { IcdCode } from '@modules/terminology/domain/IcdCode';
import { patientContainerCell } from '@modules/case/application/patientContainerAccess';

const PATIENT_CLINICAL_READ = patientContainerCell('clinical', 'read');
const PATIENT_ID = 'patient-1';

function reqRes(params: Record<string, string>, cells: string[] | null): [Request, Response] {
  const req = { params, body: {}, query: {} } as unknown as Request;
  if (cells !== null) (req as Request & { permissionCells?: string[] }).permissionCells = cells;
  const res = {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return [req, res];
}

/** Fixture real de PatientDiagnosis (mesmo molde de DiagnosisPublicView.test.ts). */
function diagnosisFixture(overrides: Partial<{ id: string; conceptTitle: string; isPrimary: boolean }> = {}) {
  return PatientDiagnosis.reconstruct({
    id: overrides.id ?? 'd1',
    patientId: PATIENT_ID,
    terminologySystem: 'ICD-11',
    conceptUri: 'http://id.who.int/icd/release/11/2026-01/mms/6A02',
    conceptCode: IcdCode.parse('6A02.Z'),
    conceptTitle: overrides.conceptTitle ?? 'Trastorno del espectro autista',
    conceptLanguage: 'es',
    conceptGroup: '06',
    catalogRelease: '2026-01',
    source: DiagnosisSource.PANEL,
    isPrimary: overrides.isPrimary ?? true,
    active: true,
    endedAt: null,
    country: 'AR',
    createdBy: 'uid-1',
    updatedBy: 'uid-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

function fakeDiagnosisService(impl: { listForPatient: jest.Mock }): PatientDiagnosisService {
  return impl as unknown as PatientDiagnosisService;
}

describe('VacanciesController.getVacancyById — diagnoses[]/diagnosesUnavailable', () => {
  beforeEach(() => jest.clearAllMocks());

  function prepararVaga(patientId: string | null) {
    mockQuery.mockResolvedValue({
      rows: [{
        id: 'jp-1', vacancy_number: 42, schedule: null,
        patient_id: patientId, patient_first_name: 'Paciente', dependency_level: 'ALTA',
        encuadres: null, publications: null,
        service_type: null, required_professions: null, social_short_links: null,
      }],
    });
  }

  it('1. ator COM célula clínica + paciente com 2 diagnósticos → diagnoses tem 2 itens, sem code/group/release', async () => {
    prepararVaga(PATIENT_ID);
    const listForPatient = jest.fn().mockResolvedValue({
      found: true,
      diagnoses: [diagnosisFixture({ id: 'd1' }), diagnosisFixture({ id: 'd2', conceptTitle: 'Diabetes tipo II', isPrimary: false })],
    });
    const controller = new VacanciesController(fakeDiagnosisService({ listForPatient }));
    const [req, res] = reqRes({ id: 'jp-1' }, ['vacancy:read', PATIENT_CLINICAL_READ]);

    await controller.getVacancyById(req, res);

    const data = (res.json as jest.Mock).mock.calls[0][0].data;
    expect(data.diagnosesUnavailable).toBe(false);
    expect(data.diagnoses).toHaveLength(2);
    for (const d of data.diagnoses) {
      const keys = Object.keys(d);
      expect(keys).not.toContain('conceptCode');
      expect(keys).not.toContain('code');
      expect(keys).not.toContain('conceptGroup');
      expect(keys).not.toContain('group');
      expect(keys).not.toContain('catalogRelease');
      expect(keys).not.toContain('release');
    }
    expect(data.diagnoses[0]).toEqual({
      id: 'd1', uri: expect.any(String), title: 'Trastorno del espectro autista', isPrimary: true, source: 'PANEL', active: true,
    });
    expect(listForPatient).toHaveBeenCalledWith(PATIENT_ID);
  });

  it('2. ator SEM célula clínica → diagnoses === null (nunca [])', async () => {
    prepararVaga(PATIENT_ID);
    const listForPatient = jest.fn();
    const controller = new VacanciesController(fakeDiagnosisService({ listForPatient }));
    const [req, res] = reqRes({ id: 'jp-1' }, ['vacancy:read']);

    await controller.getVacancyById(req, res);

    const data = (res.json as jest.Mock).mock.calls[0][0].data;
    expect(data.diagnoses).toBeNull();
    expect(data.diagnosesUnavailable).toBe(false);
    // Gate primeiro: sem a célula, o serviço nem é chamado.
    expect(listForPatient).not.toHaveBeenCalled();
  });

  it('3. repositório lança erro → diagnosesUnavailable === true, HTTP ainda 200, resto da vaga intacto', async () => {
    prepararVaga(PATIENT_ID);
    const listForPatient = jest.fn().mockRejectedValue(new Error('catálogo fora do ar'));
    const controller = new VacanciesController(fakeDiagnosisService({ listForPatient }));
    const [req, res] = reqRes({ id: 'jp-1' }, ['vacancy:read', PATIENT_CLINICAL_READ]);

    await controller.getVacancyById(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.success).toBe(true);
    expect(body.data.diagnosesUnavailable).toBe(true);
    expect(body.data.diagnoses).toEqual([]);
    // O resto da vaga não esvaziou por causa da falha do bulkhead.
    expect(body.data).toMatchObject({ id: 'jp-1', vacancy_number: 42, dependency_level: 'ALTA' });
  });

  it('4. vaga sem patient_id → diagnoses === [], diagnosesUnavailable === false', async () => {
    prepararVaga(null);
    const listForPatient = jest.fn();
    const controller = new VacanciesController(fakeDiagnosisService({ listForPatient }));
    const [req, res] = reqRes({ id: 'jp-1' }, ['vacancy:read', PATIENT_CLINICAL_READ]);

    await controller.getVacancyById(req, res);

    const data = (res.json as jest.Mock).mock.calls[0][0].data;
    expect(data.diagnoses).toEqual([]);
    expect(data.diagnosesUnavailable).toBe(false);
    expect(listForPatient).not.toHaveBeenCalled();
  });
});

describe('RecruitmentAnalyticsController.getCaseAnalysis — diagnoses[]/diagnosesUnavailable dentro de caseInfo', () => {
  beforeEach(() => jest.clearAllMocks());

  function prepararCaso(patientId: string | null) {
    mockQuery.mockResolvedValue({
      rows: [{
        id: 'jp-1', case_number: 442, patient_id: patientId,
        patient_first_name: 'Paciente', dependency_level: 'ALTA', zone_neighborhood: 'Palermo',
      }],
    });
  }

  it('1. ator COM célula clínica + paciente com diagnóstico → caseInfo.diagnoses tem 1 item, sem code/group/release', async () => {
    prepararCaso(PATIENT_ID);
    const listForPatient = jest.fn().mockResolvedValue({ found: true, diagnoses: [diagnosisFixture()] });
    const controller = new RecruitmentAnalyticsController(fakeDiagnosisService({ listForPatient }));
    const [req, res] = reqRes({ caseNumber: '442' }, ['recruitment:read', PATIENT_CLINICAL_READ]);

    await controller.getCaseAnalysis(req, res);

    const caseInfo = (res.json as jest.Mock).mock.calls[0][0].data.caseInfo;
    expect(caseInfo.diagnosesUnavailable).toBe(false);
    expect(caseInfo.diagnoses).toHaveLength(1);
    expect(Object.keys(caseInfo.diagnoses[0])).not.toContain('conceptCode');
    expect(Object.keys(caseInfo.diagnoses[0])).not.toContain('conceptGroup');
    expect(Object.keys(caseInfo.diagnoses[0])).not.toContain('catalogRelease');
    expect(listForPatient).toHaveBeenCalledWith(PATIENT_ID);
  });

  it('2. ator SEM célula clínica → caseInfo.diagnoses === null (nunca [])', async () => {
    prepararCaso(PATIENT_ID);
    const listForPatient = jest.fn();
    const controller = new RecruitmentAnalyticsController(fakeDiagnosisService({ listForPatient }));
    const [req, res] = reqRes({ caseNumber: '442' }, ['recruitment:read']);

    await controller.getCaseAnalysis(req, res);

    const caseInfo = (res.json as jest.Mock).mock.calls[0][0].data.caseInfo;
    expect(caseInfo.diagnoses).toBeNull();
    expect(caseInfo.diagnosesUnavailable).toBe(false);
    expect(listForPatient).not.toHaveBeenCalled();
  });
});
