/**
 * AdminPatientsController.test.ts
 *
 * Covers:
 *   - getPatientById (cenários 1-5)
 *   - listPatientVacancies (cenários 6-9)
 *   - listPatients — caseNumber field + case_number filter (cenários 10-12)
 */

// ─── Mocks (antes de qualquer import do módulo) ───────────────────────────────

const mockLoggerInfo = jest.fn();
jest.mock('@shared/logging', () => ({
  ...jest.requireActual('@shared/logging'),
  logger: { info: (...a: unknown[]) => mockLoggerInfo(...a), warn: jest.fn(), error: jest.fn(), child: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() })) },
}));
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

// Mock PatientTestFixtureService — o controller só traduz resultado→HTTP;
// a lógica da trava é testada em PatientTestFixtureService.test.ts.
const mockSetTestFlag = jest.fn();
const mockPurge = jest.fn();
jest.mock('../../../application/PatientTestFixtureService', () => {
  class NotATestPatientError extends Error {
    readonly code = 'NOT_A_TEST_PATIENT';
    constructor(id: string) {
      super(`Patient ${id} is not marked as is_test — refusing to purge`);
      this.name = 'NotATestPatientError';
    }
  }
  class TestVacancyHasApplicationsError extends Error {
    readonly code = 'TEST_VACANCY_HAS_APPLICATIONS';
    constructor(id: string, readonly applications: number) {
      super(`Patient ${id} has test vacancies with ${applications} real application(s) — refusing to purge`);
      this.name = 'TestVacancyHasApplicationsError';
    }
  }
  return {
    NotATestPatientError,
    TestVacancyHasApplicationsError,
    PatientTestFixtureService: jest.fn().mockImplementation(() => ({
      setTestFlag: mockSetTestFlag,
      purge: mockPurge,
    })),
  };
});

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
      // Spec 014 (lex D1.1): `completeness` entra SÓ no detalhe — fixture sem addresses/
      // contractedServices, então ambos ficam faltando (paciente ADULTO: RESPONSIBLE não exigido).
      // D255/QA-caça: `blocking` = missing ∩ ACTIVATION_BLOCKING_CODES (só ADDRESS bloqueia o
      // activate); CONTRACTED_SERVICE fica em missing mas não em blocking.
      expect((res as any).json).toHaveBeenCalledWith({
        success: true,
        data: {
          ...patient,
          // Spec 016 F2 (D263): diagnoses[] embutido — o pool mockado deste arquivo devolve
          // `undefined` de `query()` (sem mockResolvedValue), o que faz `patientExists` lançar —
          // o bulkhead do controller (reportError + []) garante que isso não derruba a ficha
          // inteira. C4 (QA-caça): a falha vira `diagnosesUnavailable: true`, nunca um `[]` mudo
          // indistinguível de "paciente sem diagnóstico" (ver teste dedicado abaixo para o
          // caminho de SUCESSO, `diagnosesUnavailable: false`).
          diagnoses: [],
          diagnosesUnavailable: true,
          completeness: {
            missing: ['ADDRESS', 'CONTRACTED_SERVICE'],
            blocking: ['ADDRESS'],
            ready: false,
            canActivate: false,
          },
        },
      });
    });

    it('ponto único (D211.2): sem células (engine não decidiu) devolve as instruções de emergência; células sem `patient_clinical:read` → null + redacted', async () => {
      const patient = makePatientDetail({ emergencyInstructions: 'Llamar 107', emergencyInstructionsUpdatedAt: new Date('2026-08-29T00:00:00Z'), emergencyInstructionsUpdatedBy: 'Gabi' } as never);
      mockFindDetailById.mockResolvedValue(patient);
      const [req, res] = mockReqRes({ id: PATIENT_ID });
      await controller.getPatientById(req, res);
      expect((res as any).json.mock.calls[0][0].data.emergencyInstructions).toBe('Llamar 107');
      expect((res as any).json.mock.calls[0][0].data.emergencyInstructionsRedacted).toBeUndefined();

      mockFindDetailById.mockResolvedValue(patient);
      const [req2, res2] = mockReqRes({ id: PATIENT_ID });
      (req2 as any).permissionCells = ['patient:read'];
      await controller.getPatientById(req2, res2);
      const data = (res2 as any).json.mock.calls[0][0].data;
      expect(data).toMatchObject({ emergencyInstructions: null, emergencyInstructionsUpdatedAt: null, emergencyInstructionsUpdatedBy: null, emergencyInstructionsRedacted: true });
      expect(data.diagnosis).toBe(patient.diagnosis);
    });

    it('C3: leitura permitida gera trilha SEM valor (uid, paciente, país, decisão); redigida não gera', async () => {
      const patient = makePatientDetail({ emergencyInstructions: 'Llamar 107' } as never);
      mockFindDetailById.mockResolvedValue(patient);
      const [req, res] = mockReqRes({ id: PATIENT_ID });
      await controller.getPatientById(req, res);
      const call = mockLoggerInfo.mock.calls.find((c: unknown[]) => (c[0] as { msg: string }).msg === 'patient_clinical.read');
      expect(call).toBeDefined();
      expect(JSON.stringify(call![0])).not.toContain('Llamar 107');
      expect(call![0]).toMatchObject({ patientId: PATIENT_ID, decision: 'allowed', country: 'AR' });
      mockLoggerInfo.mockClear(); mockFindDetailById.mockResolvedValue(patient);
      const [req2, res2] = mockReqRes({ id: PATIENT_ID }); (req2 as any).permissionCells = [];
      await controller.getPatientById(req2, res2);
      expect(mockLoggerInfo.mock.calls.some((c: unknown[]) => (c[0] as { msg: string }).msg === 'patient_clinical.read')).toBe(false);
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

  describe('Spec 016 F2 — diagnoses[]/diagnosesUnavailable e o construtor lazy da porta (C4/C7, QA-caça correções)', () => {
    afterEach(() => {
      delete process.env.TERMINOLOGY_ADAPTER;
    });

    it('C4 — diagnosesUnavailable:false quando o serviço de diagnóstico responde normalmente (injetado por construtor)', async () => {
      const patient = makePatientDetail();
      mockFindDetailById.mockResolvedValue(patient);
      const fakeDiagnosisService = { listForPatient: jest.fn().mockResolvedValue({ found: true, diagnoses: [] }) };
      const withDiagnosis = new AdminPatientsController(
        undefined,
        undefined,
        undefined,
        undefined,
        fakeDiagnosisService as unknown as ConstructorParameters<typeof AdminPatientsController>[4],
      );
      const [req, res] = mockReqRes({ id: PATIENT_ID });
      await withDiagnosis.getPatientById(req, res);
      const data = (res as any).json.mock.calls[0][0].data;
      expect(data.diagnosesUnavailable).toBe(false);
      expect(data.diagnoses).toEqual([]);
      expect(fakeDiagnosisService.listForPatient).toHaveBeenCalledWith(PATIENT_ID);
    });

    it('paciente sem diagnóstico registrado (`found:false`) → lista vazia e `diagnosesUnavailable:false` (é ausência, não avaria)', async () => {
      mockFindDetailById.mockResolvedValue(makePatientDetail());
      const fakeDiagnosisService = { listForPatient: jest.fn().mockResolvedValue({ found: false }) };
      const withDiagnosis = new AdminPatientsController(
        undefined, undefined, undefined, undefined,
        fakeDiagnosisService as unknown as ConstructorParameters<typeof AdminPatientsController>[4],
      );
      const [req, res] = mockReqRes({ id: PATIENT_ID });
      await withDiagnosis.getPatientById(req, res);
      const data = (res as any).json.mock.calls[0][0].data;
      expect(data).toMatchObject({ diagnoses: [], diagnosesUnavailable: false });
    });

    it('serviço de diagnóstico rejeitando com algo que NÃO é Error também vira diagnosesUnavailable (bulkhead, sem crash)', async () => {
      mockFindDetailById.mockResolvedValue(makePatientDetail());
      const fakeDiagnosisService = { listForPatient: jest.fn().mockRejectedValue('rejeição crua') };
      const withDiagnosis = new AdminPatientsController(
        undefined, undefined, undefined, undefined,
        fakeDiagnosisService as unknown as ConstructorParameters<typeof AdminPatientsController>[4],
      );
      const [req, res] = mockReqRes({ id: PATIENT_ID });
      await withDiagnosis.getPatientById(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect((res as any).json.mock.calls[0][0].data).toMatchObject({ diagnoses: [], diagnosesUnavailable: true });
    });

    it('ficha sem as coleções (payload legado): o checklist conta 0 em vez de estourar', async () => {
      const patient = makePatientDetail();
      delete (patient as Record<string, unknown>).responsibles;
      delete (patient as Record<string, unknown>).addresses;
      mockFindDetailById.mockResolvedValue({ ...patient, contractedServices: undefined });
      const [req, res] = mockReqRes({ id: PATIENT_ID });
      await controller.getPatientById(req, res);
      expect((res as any).json.mock.calls[0][0].data.completeness.missing).toEqual(['ADDRESS', 'CONTRACTED_SERVICE']);
    });

    it('C7 — TERMINOLOGY_ADAPTER com typo NÃO derruba o construtor nem a rota inteira; vira diagnosesUnavailable:true, nunca crash de processo', async () => {
      process.env.TERMINOLOGY_ADAPTER = 'postgress'; // typo real medido pelo QA-caça
      expect(() => new AdminPatientsController()).not.toThrow();

      const patient = makePatientDetail();
      mockFindDetailById.mockResolvedValue(patient);
      const freshController = new AdminPatientsController();
      const [req, res] = mockReqRes({ id: PATIENT_ID });
      await freshController.getPatientById(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      const data = (res as any).json.mock.calls[0][0].data;
      expect(data.diagnosesUnavailable).toBe(true);
      expect(data.diagnoses).toEqual([]);
    });

    it('reusa a MESMA porta entre chamadas (memoizado) — 2 requisições na mesma instância, nenhuma reconstrói nem lança', async () => {
      const patient = makePatientDetail();
      mockFindDetailById.mockResolvedValue(patient);
      const freshController = new AdminPatientsController(); // TERMINOLOGY_ADAPTER default ('postgres')
      const [req1, res1] = mockReqRes({ id: PATIENT_ID });
      await freshController.getPatientById(req1, res1);
      const [req2, res2] = mockReqRes({ id: PATIENT_ID });
      await freshController.getPatientById(req2, res2);
      expect(res1.status).toHaveBeenCalledWith(200);
      expect(res2.status).toHaveBeenCalledWith(200);
    });
  });

  describe('Cenário 1b — completeness (spec 014 US-D1, lex D1.1/D1.2)', () => {
    /** Horário válido: desde 07/09 serviço ativo sem horário acusa SERVICE_SCHEDULE, e os testes
     *  abaixo medem OUTROS códigos — sem isto falhariam por motivo alheio ao que verificam. */
    const HORARIO_OK = [{ dayOfWeek: 2, startTime: '09:00', endTime: '13:00' }];

    // Migration 330: serviço ativo SEM endereço (ou com endereço que não está na ficha = arquivado)
    // → SERVICE_ADDRESS em missing E em blocking — a ficha mostra o mesmo que o activate recusa.
    it('serviço ativo sem endereço vinculado → SERVICE_ADDRESS em missing e blocking, canActivate false', async () => {
      const patient = makePatientDetail({
        addresses: [{ id: 'a1', addressType: 'primary' }],
        contractedServices: [{ active: true, addressId: null, schedule: HORARIO_OK }],
      });
      mockFindDetailById.mockResolvedValue(patient);

      const [req, res] = mockReqRes({ id: PATIENT_ID });
      await controller.getPatientById(req, res);

      const completeness = (res as any).json.mock.calls[0][0].data.completeness;
      expect(completeness.missing).toEqual(['SERVICE_ADDRESS']);
      expect(completeness.blocking).toEqual(['SERVICE_ADDRESS']);
      expect(completeness.canActivate).toBe(false);
    });

    it('serviço ativo apontando para endereço que NÃO está na ficha (arquivado) → SERVICE_ADDRESS', async () => {
      const patient = makePatientDetail({
        addresses: [{ id: 'a1', addressType: 'primary' }],
        contractedServices: [{ active: true, addressId: 'a-arquivado', schedule: HORARIO_OK }],
      });
      mockFindDetailById.mockResolvedValue(patient);

      const [req, res] = mockReqRes({ id: PATIENT_ID });
      await controller.getPatientById(req, res);

      expect((res as any).json.mock.calls[0][0].data.completeness.blocking).toEqual(['SERVICE_ADDRESS']);
    });

    // Decisão do Gabriel 07/09: a ficha mostra a falta de horário do mesmo jeito que o activate a recusa.
    it('serviço ativo sem horário → SERVICE_SCHEDULE em missing E em blocking, canActivate false', async () => {
      const patient = makePatientDetail({
        addresses: [{ id: 'a1', addressType: 'primary' }],
        contractedServices: [{ active: true, addressId: 'a1', schedule: null }],
      });
      mockFindDetailById.mockResolvedValue(patient);

      const [req, res] = mockReqRes({ id: PATIENT_ID });
      await controller.getPatientById(req, res);

      const c = (res as any).json.mock.calls[0][0].data.completeness;
      expect(c.missing).toContain('SERVICE_SCHEDULE');
      expect(c.blocking).toEqual(['SERVICE_SCHEDULE']);
      expect(c.canActivate).toBe(false);
    });

    it('horário ARRAY VAZIO na ficha também acusa SERVICE_SCHEDULE (`[]` não é horário)', async () => {
      const patient = makePatientDetail({
        addresses: [{ id: 'a1', addressType: 'primary' }],
        contractedServices: [{ active: true, addressId: 'a1', schedule: [] }],
      });
      mockFindDetailById.mockResolvedValue(patient);

      const [req, res] = mockReqRes({ id: PATIENT_ID });
      await controller.getPatientById(req, res);

      expect((res as any).json.mock.calls[0][0].data.completeness.missing).toContain('SERVICE_SCHEDULE');
    });

    it('serviço INATIVO sem horário não acusa — a régua é sobre serviço ATIVO', async () => {
      const patient = makePatientDetail({
        addresses: [{ id: 'a1', addressType: 'primary' }],
        contractedServices: [
          { active: true, addressId: 'a1', schedule: HORARIO_OK },
          { active: false, addressId: 'a1', schedule: null },
        ],
      });
      mockFindDetailById.mockResolvedValue(patient);

      const [req, res] = mockReqRes({ id: PATIENT_ID });
      await controller.getPatientById(req, res);

      expect((res as any).json.mock.calls[0][0].data.completeness.missing).not.toContain('SERVICE_SCHEDULE');
    });

    it('todos os critérios satisfeitos → ready:true, missing:[]', async () => {
      const patient = makePatientDetail({
        addresses: [{ id: 'a1', addressType: 'primary' }],
        contractedServices: [{ active: true, addressId: 'a1', schedule: HORARIO_OK }],
      });
      mockFindDetailById.mockResolvedValue(patient);

      const [req, res] = mockReqRes({ id: PATIENT_ID });
      await controller.getPatientById(req, res);

      expect((res as any).json.mock.calls[0][0].data.completeness).toEqual({
        missing: [],
        blocking: [],
        ready: true,
        canActivate: true,
      });
    });

    it('serviço contratado INATIVO não conta — CONTRACTED_SERVICE continua em missing', async () => {
      const patient = makePatientDetail({
        addresses: [{ id: 'a1', addressType: 'primary' }],
        contractedServices: [{ active: false }],
      });
      mockFindDetailById.mockResolvedValue(patient);

      const [req, res] = mockReqRes({ id: PATIENT_ID });
      await controller.getPatientById(req, res);

      expect((res as any).json.mock.calls[0][0].data.completeness.missing).toContain('CONTRACTED_SERVICE');
    });

    it('paciente MENOR sem responsável → RESPONSIBLE em missing', async () => {
      const patient = makePatientDetail({
        birthDate: new Date(new Date().getFullYear() - 5, 0, 1), // 5 anos
        addresses: [{ id: 'a1', addressType: 'primary' }],
        contractedServices: [{ active: true, addressId: 'a1', schedule: HORARIO_OK }],
        responsibles: [],
      });
      mockFindDetailById.mockResolvedValue(patient);

      const [req, res] = mockReqRes({ id: PATIENT_ID });
      await controller.getPatientById(req, res);

      expect((res as any).json.mock.calls[0][0].data.completeness.missing).toContain('RESPONSIBLE');
    });

    it('sem consentimento (hasConsent false) → CONSENT em missing', async () => {
      const patient = makePatientDetail({
        addresses: [{ id: 'a1', addressType: 'primary' }],
        contractedServices: [{ active: true, addressId: 'a1', schedule: HORARIO_OK }],
        hasConsent: false,
      } as never);
      mockFindDetailById.mockResolvedValue(patient);

      const [req, res] = mockReqRes({ id: PATIENT_ID });
      await controller.getPatientById(req, res);

      const completeness = (res as any).json.mock.calls[0][0].data.completeness;
      expect(completeness.missing).toEqual(['CONSENT']);
      // D255: CONSENT não bloqueia o activate — só ADDRESS bloqueia.
      expect(completeness.blocking).toEqual([]);
      expect(completeness.canActivate).toBe(true);
    });

    it('lex D1.2: nenhum código do checklist nomeia conteúdo clínico', async () => {
      const patient = makePatientDetail();
      mockFindDetailById.mockResolvedValue(patient);

      const [req, res] = mockReqRes({ id: PATIENT_ID });
      await controller.getPatientById(req, res);

      const { missing } = (res as any).json.mock.calls[0][0].data.completeness;
      for (const code of missing) {
        expect(['ADDRESS', 'RESPONSIBLE', 'COVERAGE', 'CONTRACTED_SERVICE', 'CONSENT']).toContain(code);
      }
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

  describe('Cenário 13 — contrato D1.1 (spec 014): `missing` NUNCA na lista, só booleano', () => {
    it('a linha da lista tem needsAttention (booleano) e attentionReasons (enum), e NÃO tem `completeness`/`missing`', async () => {
      mockList.mockResolvedValue({ rows: [{ ...baseRow, needsAttention: true, attentionReasons: ['NO_CONTACT_CHANNEL'] }], total: 1 });

      const [req, res] = mockReqResWithQuery({});
      await controller.listPatients(req, res);

      const row = (res as any).json.mock.calls[0][0].data[0];
      expect(typeof row.needsAttention).toBe('boolean');
      expect(Array.isArray(row.attentionReasons)).toBe(true);
      expect(row).not.toHaveProperty('completeness');
      expect(row).not.toHaveProperty('missing');
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

// ─── test-flag / purge (synthetic monitoring) ─────────────────────────────────

describe('AdminPatientsController — purge de paciente sintético', () => {
  beforeEach(() => {
    mockPurge.mockReset();
    mockSetTestFlag.mockReset();
  });

  it('409 quando o paciente NÃO é de teste (a trava chega intacta no HTTP)', async () => {
    const { NotATestPatientError } = jest.requireMock('../../../application/PatientTestFixtureService');
    mockPurge.mockRejectedValue(new NotATestPatientError(PATIENT_ID));
    const controller = new AdminPatientsController();
    const [req, res] = mockReqRes({ id: PATIENT_ID });

    await controller.purgeTestPatient(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    const body = (res.status as jest.Mock).mock.results[0].value.json.mock.calls[0][0];
    expect(body).toMatchObject({ success: false, code: 'NOT_A_TEST_PATIENT' });
  });

  it('409 quando a vaga sintética tem candidatura de prestador real (C3)', async () => {
    const { TestVacancyHasApplicationsError } = jest.requireMock(
      '../../../application/PatientTestFixtureService',
    );
    mockPurge.mockRejectedValue(new TestVacancyHasApplicationsError(PATIENT_ID, 2));
    const controller = new AdminPatientsController();
    const [req, res] = mockReqRes({ id: PATIENT_ID });

    await controller.purgeTestPatient(req, res);

    // 409 e não 500: é uma RECUSA deliberada, e quem chamou precisa saber
    // quantas candidaturas de gente real seriam perdidas.
    expect(res.status).toHaveBeenCalledWith(409);
    const body = (res.status as jest.Mock).mock.results[0].value.json.mock.calls[0][0];
    expect(body).toMatchObject({
      success: false,
      code: 'TEST_VACANCY_HAS_APPLICATIONS',
      applications: 2,
    });
  });

  it('404 quando o paciente não existe', async () => {
    mockPurge.mockResolvedValue(null);
    const controller = new AdminPatientsController();
    const [req, res] = mockReqRes({ id: PATIENT_ID });

    await controller.purgeTestPatient(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('200 devolvendo a evidência do que foi limpo', async () => {
    const evidencia = {
      patientId: PATIENT_ID,
      appointmentsCancelled: 1,
      calendarEventsDeleted: 1,
      calendarEventsFailed: 0,
      vacanciesDeleted: 0,
    };
    mockPurge.mockResolvedValue(evidencia);
    const controller = new AdminPatientsController();
    const [req, res] = mockReqRes({ id: PATIENT_ID });

    await controller.purgeTestPatient(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = (res.status as jest.Mock).mock.results[0].value.json.mock.calls[0][0];
    expect(body).toEqual({ success: true, data: evidencia });
  });

  it('400 quando o id não é UUID (não chega no serviço)', async () => {
    const controller = new AdminPatientsController();
    const [req, res] = mockReqRes({ id: 'nao-e-uuid' });

    await controller.purgeTestPatient(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockPurge).not.toHaveBeenCalled();
  });
});

describe('AdminPatientsController — test-flag', () => {
  beforeEach(() => {
    mockSetTestFlag.mockReset();
  });

  it('200 e devolve a marca gravada', async () => {
    mockSetTestFlag.mockResolvedValue(true);
    const controller = new AdminPatientsController();
    const [req, res] = mockReqRes({ id: PATIENT_ID });
    (req as unknown as { body: unknown }).body = { isTest: true };

    await controller.updatePatientTestFlag(req, res);

    expect(mockSetTestFlag).toHaveBeenCalledWith(PATIENT_ID, true);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('400 quando o body não traz isTest booleano', async () => {
    const controller = new AdminPatientsController();
    const [req, res] = mockReqRes({ id: PATIENT_ID });
    (req as unknown as { body: unknown }).body = { isTest: 'sim' };

    await controller.updatePatientTestFlag(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockSetTestFlag).not.toHaveBeenCalled();
  });

  it('404 quando o paciente não existe', async () => {
    mockSetTestFlag.mockResolvedValue(null);
    const controller = new AdminPatientsController();
    const [req, res] = mockReqRes({ id: PATIENT_ID });
    (req as unknown as { body: unknown }).body = { isTest: true };

    await controller.updatePatientTestFlag(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe('AdminPatientsController.getPatientById — trilha de leitura (C3) com e sem contexto de auth', () => {
  let controller: AdminPatientsController;
  beforeEach(() => { jest.clearAllMocks(); controller = new AdminPatientsController(); });

  it('com auth context: a trilha leva o uid do principal; país ausente sai null — nunca o texto', async () => {
    const patient = makePatientDetail({ emergencyInstructions: 'Llamar 107', country: null } as never);
    mockFindDetailById.mockResolvedValue(patient);
    const [req, res] = mockReqRes({ id: PATIENT_ID });
    (req as any).authContext = { principal: { id: 'uid-staff-7' } };
    await controller.getPatientById(req, res);
    const call = mockLoggerInfo.mock.calls.find((c: unknown[]) => (c[0] as { msg: string }).msg === 'patient_clinical.read');
    expect(call![0]).toMatchObject({ uid: 'uid-staff-7', patientId: PATIENT_ID, country: null, decision: 'allowed' });
    expect(JSON.stringify(call![0])).not.toContain('Llamar 107');
  });

  it('sem auth context (rota montada sem o middleware): uid null na trilha, resposta 200 igual', async () => {
    const patient = makePatientDetail({ emergencyInstructions: 'Llamar 107' } as never);
    mockFindDetailById.mockResolvedValue(patient);
    const [req, res] = mockReqRes({ id: PATIENT_ID });
    await controller.getPatientById(req, res);
    const call = mockLoggerInfo.mock.calls.find((c: unknown[]) => (c[0] as { msg: string }).msg === 'patient_clinical.read');
    expect(call![0]).toMatchObject({ uid: null, country: 'AR' });
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
