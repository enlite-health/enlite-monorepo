/**
 * PublicVacancyController — caminho PADRÃO do serviço de diagnóstico (spec 042).
 *
 * `PublicVacancyController.test.ts` injeta um serviço fake pelo construtor; aqui NÃO há override,
 * então o controller tem de montar sozinho (lazy) `PatientDiagnosisService(createTerminologyPort(env),
 * PostgresPatientDiagnosisRepository(PANEL))` — o mesmo desenho de `VacanciesController`. Os três
 * construtores são mockados só para observar COMO são chamados; o rótulo vem do fake do serviço.
 */
const mockQuery = jest.fn();
const mockListForPatient = jest.fn();
const mockServiceCtor = jest.fn();
const mockRepoCtor = jest.fn();
const mockCreateTerminologyPort = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({ query: (...a: unknown[]) => mockQuery(...a) }),
    }),
  },
}));

jest.mock('@modules/terminology/infrastructure/TerminologyPortFactory', () => ({
  createTerminologyPort: (...a: unknown[]) => mockCreateTerminologyPort(...a),
}));

jest.mock('@modules/diagnosis/infrastructure/PostgresPatientDiagnosisRepository', () => ({
  PostgresPatientDiagnosisRepository: function (...a: unknown[]) {
    mockRepoCtor(...a);
    return { __repo: true };
  },
}));

jest.mock('@modules/diagnosis/application/PatientDiagnosisService', () => ({
  PatientDiagnosisService: function (...a: unknown[]) {
    mockServiceCtor(...a);
    return { listForPatient: (...b: unknown[]) => mockListForPatient(...b) };
  },
}));

import type { Request, Response } from 'express';
import { PublicVacancyController } from '../PublicVacancyController';
import { DiagnosisSource } from '@modules/diagnosis/domain/DiagnosisSource';

const VACANCY_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const PATIENT_ID = '11111111-2222-3333-4444-555555555555';
const PORT = { __port: true };

function reqRes(): [Request, Response] {
  const req = { params: { id: VACANCY_ID }, query: {}, body: {} } as unknown as Request;
  const res = { json: jest.fn().mockReturnThis(), status: jest.fn().mockReturnThis() } as unknown as Response;
  return [req, res];
}

const row = () => ({
  id: VACANCY_ID, case_number: 42, vacancy_number: 1, title: 'CASO 42', status: 'SEARCHING',
  patient_id: PATIENT_ID, service_type: ['AT'], required_professions: ['AT'], required_sex: null,
  age_range_min: null, age_range_max: null, worker_attributes: null, schedule: null,
  schedule_days_hours: null, salary_text: null, talentum_description: null, talentum_whatsapp_url: null,
  country: 'AR', created_at: '2025-01-01T00:00:00Z', patient_zone: null,
});

describe('PublicVacancyController — serviço de diagnóstico padrão (sem override)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateTerminologyPort.mockReturnValue(PORT);
    mockQuery.mockImplementation(async () => ({ rows: [row()] }));
    mockListForPatient.mockResolvedValue({
      found: true,
      diagnoses: [{
        conceptTitle: 'Diagnóstico sintético QA', conceptLanguage: 'es',
        source: DiagnosisSource.PANEL, isPrimary: true, active: true,
      }],
    });
  });

  it('constrói PatientDiagnosisService(porta de terminologia, repositório PANEL) e usa para o rótulo', async () => {
    const controller = new PublicVacancyController();
    // Lazy: construir o controller não monta nada (env inválida não derruba o boot).
    expect(mockServiceCtor).not.toHaveBeenCalled();
    expect(mockCreateTerminologyPort).not.toHaveBeenCalled();

    const [req, res] = reqRes();
    await controller.getById(req, res);

    expect(mockCreateTerminologyPort).toHaveBeenCalledTimes(1);
    expect(mockCreateTerminologyPort).toHaveBeenCalledWith(process.env);
    expect(mockRepoCtor).toHaveBeenCalledTimes(1);
    expect(mockRepoCtor.mock.calls[0][0]).toBe(DiagnosisSource.PANEL);
    expect(mockServiceCtor).toHaveBeenCalledTimes(1);
    expect(mockServiceCtor.mock.calls[0][0]).toBe(PORT);
    expect(mockServiceCtor.mock.calls[0][1]).toEqual({ __repo: true });

    expect(mockListForPatient).toHaveBeenCalledWith(PATIENT_ID);
    expect(res.status).toHaveBeenCalledWith(200);
    expect((res.json as jest.Mock).mock.calls[0][0].data.diagnosisLabel).toBe('Diagnóstico sintético QA');
  });

  it('memoiza: duas requisições montam o serviço UMA vez só', async () => {
    const controller = new PublicVacancyController();
    for (let i = 0; i < 2; i++) {
      const [req, res] = reqRes();
      await controller.getById(req, res);
    }
    expect(mockServiceCtor).toHaveBeenCalledTimes(1);
    expect(mockCreateTerminologyPort).toHaveBeenCalledTimes(1);
    expect(mockListForPatient).toHaveBeenCalledTimes(2);
  });
});
