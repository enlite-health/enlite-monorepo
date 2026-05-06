/**
 * GetPatientByIdUseCase.test.ts
 *
 * Cenários:
 *   1. Happy path — paciente encontrado → { found: true, patient }
 *   2. Not found — repo retorna null → { found: false }
 *   3. Erro do repositório — propaga sem mascarar
 *   4. findDetailById é chamado exatamente 1 vez com o id correto
 */

import { GetPatientByIdUseCase } from '../GetPatientByIdUseCase';
import type { PatientDetailRow } from '../../infrastructure/PatientQueryRepository';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PATIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const mockPatient: PatientDetailRow = {
  id: PATIENT_ID,
  clickupTaskId: 'CU-001',
  firstName: 'Juan',
  lastName: 'Pérez',
  birthDate: new Date('1990-05-15'),
  documentType: 'DNI',
  documentNumber: '12345678',
  affiliateId: 'AF-001',
  sex: 'MALE',
  phoneWhatsapp: '+5491100000000',
  diagnosis: 'ASD',
  dependencyLevel: 'MODERATE',
  clinicalSpecialty: 'ASD',
  clinicalSegments: null,
  serviceType: ['AT'],
  deviceType: 'DOMICILIARIO',
  additionalComments: 'Needs structured environment',
  hasJudicialProtection: false,
  hasCud: true,
  hasConsent: true,
  insuranceInformed: 'OSDE',
  insuranceVerified: 'OSDE',
  cityLocality: 'CABA',
  province: 'Buenos Aires',
  zoneNeighborhood: 'Palermo',
  country: 'AR',
  status: 'ACTIVE',
  needsAttention: false,
  attentionReasons: [],
  lastCaseNumber: null,
  responsibles: [
    {
      id: 'r1',
      firstName: 'María',
      lastName: 'Pérez',
      relationship: 'PARENT',
      phone: '+5491111111111',
      email: 'maria@example.com',
      documentNumber: '87654321',
      documentType: 'DNI',
      isPrimary: true,
      displayOrder: 1,
      source: 'clickup',
    },
  ],
  addresses: [
    {
      id: 'a1',
      addressType: 'primary',
      addressFormatted: 'Av. Corrientes 1234',
      addressRaw: 'Av. Corrientes 1234, CABA',
      complement: null,
      displayOrder: 1,
      lat: null,
      lng: null,
      isPrimary: true,
      availability: {
        totalCoveredHours: 0,
        maxHours: 168 as const,
        isFull: false,
        perDay: [],
        activeVacanciesCount: 0,
        hasUnknownSchedule: false,
      },
    },
  ],
  professionals: [
    {
      id: 'pr1',
      name: 'Dr. García',
      phone: '+5491122222222',
      email: 'garcia@clinic.com',
      displayOrder: 1,
      isTeam: false,
    },
  ],
  createdAt: new Date('2025-01-01T00:00:00Z'),
  updatedAt: new Date('2025-06-01T00:00:00Z'),
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRepo(overrides: { findDetailById?: jest.Mock } = {}) {
  return {
    findDetailById: jest.fn().mockResolvedValue(mockPatient),
    list: jest.fn(),
    stats: jest.fn(),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GetPatientByIdUseCase', () => {
  describe('Cenário 1 — Paciente encontrado', () => {
    it('deve retornar { found: true, patient } quando o repositório retorna o registro', async () => {
      const repo = makeRepo();
      const useCase = new GetPatientByIdUseCase(repo as any);

      const result = await useCase.execute(PATIENT_ID);

      expect(result.found).toBe(true);
      if (result.found) {
        expect(result.patient).toEqual(mockPatient);
      }
    });

    it('deve repassar o objeto patient exatamente como retornado pelo repositório', async () => {
      const repo = makeRepo({ findDetailById: jest.fn().mockResolvedValue(mockPatient) });
      const useCase = new GetPatientByIdUseCase(repo as any);

      const result = await useCase.execute(PATIENT_ID);

      expect(result.found).toBe(true);
      if (result.found) {
        expect(result.patient.id).toBe(PATIENT_ID);
        expect(result.patient.responsibles).toHaveLength(1);
        expect(result.patient.addresses).toHaveLength(1);
        expect(result.patient.professionals).toHaveLength(1);
      }
    });
  });

  describe('Cenário 2 — Paciente não encontrado', () => {
    it('deve retornar { found: false } quando o repositório retorna null', async () => {
      const repo = makeRepo({ findDetailById: jest.fn().mockResolvedValue(null) });
      const useCase = new GetPatientByIdUseCase(repo as any);

      const result = await useCase.execute(PATIENT_ID);

      expect(result.found).toBe(false);
    });
  });

  describe('Cenário 3 — Erro do repositório', () => {
    it('deve propagar o erro sem mascarar', async () => {
      const dbError = new Error('DB connection lost');
      const repo = makeRepo({ findDetailById: jest.fn().mockRejectedValue(dbError) });
      const useCase = new GetPatientByIdUseCase(repo as any);

      await expect(useCase.execute(PATIENT_ID)).rejects.toThrow('DB connection lost');
    });
  });

  describe('Cenário 4 — Contrato de chamada', () => {
    it('deve chamar findDetailById exatamente uma vez com o id correto', async () => {
      const findDetailById = jest.fn().mockResolvedValue(mockPatient);
      const repo = makeRepo({ findDetailById });
      const useCase = new GetPatientByIdUseCase(repo as any);

      await useCase.execute(PATIENT_ID);

      expect(findDetailById).toHaveBeenCalledTimes(1);
      expect(findDetailById).toHaveBeenCalledWith(PATIENT_ID);
    });
  });
});
