/**
 * PatientService — upsertRelated conditional branches + contact-channel with
 * responsibles present (migration 251 era, ClickUp upsert path).
 *
 * Covers previously-uncovered branches inside upsertFromClickUp/upsertRelated:
 *  1. responsibles present + valid contact channel → validateContactChannel
 *     runs and passes (find primary, no throw).
 *  2. responsibles present + missing channel + strategy 'error' → rethrows.
 *  3. responsibles present + missing channel + strategy 'flag' → flagged=true,
 *     MISSING_INFO added, upsert still completes.
 *  4. addresses !== undefined → replacePatientAddresses called.
 *  5. professionals !== undefined → replacePatientProfessionals called.
 */

// ── Mocks (must appear before imports) ───────────────────────────────────────

let _queryImpl: (sql: string) => Promise<unknown> = async () => undefined;

const mockClient = {
  query:   jest.fn(async (sql: string) => _queryImpl(sql)),
  release: jest.fn(),
};

const mockGetClient = jest.fn().mockResolvedValue(mockClient);

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn(() => ({
      getPool:   jest.fn(() => ({})),
      getClient: mockGetClient,
    })),
  },
}));

jest.mock(
  '../../infrastructure/PatientIdentityRepository',
  () => ({
    PatientIdentityRepository: jest.fn().mockImplementation(() => ({
      upsert: jest.fn(),
    })),
  }),
);

jest.mock(
  '../../infrastructure/PatientClinicalRepository',
  () => ({
    PatientClinicalRepository: jest.fn().mockImplementation(() => ({
      upsert: jest.fn().mockResolvedValue(undefined),
    })),
  }),
);

const mockReplaceAll = jest.fn().mockResolvedValue(undefined);
const mockReplaceBySource = jest.fn().mockResolvedValue(undefined);
jest.mock(
  '../../infrastructure/PatientResponsibleRepository',
  () => ({
    PatientResponsibleRepository: jest.fn().mockImplementation(() => ({
      replaceAll: (...args: unknown[]) => mockReplaceAll(...args),
      replaceBySource: (...args: unknown[]) => mockReplaceBySource(...args),
    })),
  }),
);

jest.mock('../../infrastructure/geocodePatientAddresses', () => ({
  geocodePatientAddressesBestEffort: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../../../infrastructure/services/GeocodingService', () => ({
  GeocodingService: jest.fn().mockImplementation(() => ({})),
}));

const mockReplacePatientAddresses = jest.fn().mockResolvedValue(undefined);
const mockReplacePatientProfessionals = jest.fn().mockResolvedValue(undefined);
jest.mock('../PatientRelatedWriter', () => ({
  replacePatientAddresses:    (...args: unknown[]) => mockReplacePatientAddresses(...args),
  replacePatientProfessionals: (...args: unknown[]) => mockReplacePatientProfessionals(...args),
}));

jest.mock('firebase-functions', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { PatientService, type PatientServiceUpsertInput } from '../PatientService';
import { PatientIdentityRepository } from '../../infrastructure/PatientIdentityRepository';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeInput(overrides: Partial<PatientServiceUpsertInput> = {}): PatientServiceUpsertInput {
  return {
    clickupTaskId: 'task-related',
    firstName:     'Ana',
    lastName:      'García',
    caseNumber:    1,
    ...overrides,
  } as PatientServiceUpsertInput;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PatientService.upsertFromClickUp — responsibles / addresses / professionals branches', () => {
  let service: PatientService;
  let mockIdentityUpsert: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    _queryImpl = async () => undefined;
    service = new PatientService();

    const identityInstance = (PatientIdentityRepository as jest.Mock).mock.results[
      (PatientIdentityRepository as jest.Mock).mock.results.length - 1
    ].value as { upsert: jest.Mock };
    mockIdentityUpsert = identityInstance.upsert;
    mockGetClient.mockResolvedValue(mockClient);
  });

  it('1. responsibles present with a valid contact channel (primary has phone) — no throw, o SYNC substitui só as linhas clickup (replaceBySource), nunca replaceAll', async () => {
    mockIdentityUpsert.mockResolvedValueOnce({ id: 'patient-r1', created: true });

    const result = await service.upsertFromClickUp(
      makeInput({
        phoneWhatsapp: undefined,
        responsibles: [
          { firstName: 'María', lastName: 'López', phone: '+5491100000001', isPrimary: true, displayOrder: 1 },
        ],
      }),
    );

    expect(result.id).toBe('patient-r1');
    // QA caça 🔴1: o caminho do sync NÃO pode apagar familiar do painel/formulário.
    expect(mockReplaceAll).not.toHaveBeenCalled();
    expect(mockReplaceBySource).toHaveBeenCalledTimes(1);
    expect(mockReplaceBySource.mock.calls[0][0]).toBe('patient-r1');
    expect(mockReplaceBySource.mock.calls[0][2]).toBe('clickup');
  });

  it('2. responsibles present, no contact channel at all, strategy "error" (default) → rethrows', async () => {
    await expect(
      service.upsertFromClickUp(
        makeInput({
          phoneWhatsapp: undefined,
          responsibles: [
            { firstName: 'Sin', lastName: 'Contacto', isPrimary: true, displayOrder: 1 },
          ],
        }),
      ),
    ).rejects.toThrow(/canal/i);

    // Never reached the DB — validation fails before the transaction starts.
    expect(mockIdentityUpsert).not.toHaveBeenCalled();
  });

  it('3. responsibles present, no contact channel, strategy "flag" → flagged=true + MISSING_INFO, upsert completes', async () => {
    mockIdentityUpsert.mockResolvedValueOnce({ id: 'patient-r3', created: true });

    const result = await service.upsertFromClickUp(
      makeInput({
        phoneWhatsapp: undefined,
        responsibles: [
          { firstName: 'Sin', lastName: 'Contacto', isPrimary: true, displayOrder: 1 },
        ],
      }),
      { onMissingContact: 'flag' },
    );

    expect(result.flagged).toBe(true);
    expect(result.id).toBe('patient-r3');
    const upsertArg = mockIdentityUpsert.mock.calls[0][0] as PatientServiceUpsertInput & { needsAttention: boolean; attentionReasons: string[] };
    expect(upsertArg.needsAttention).toBe(true);
    expect(upsertArg.attentionReasons).toContain('MISSING_INFO');
  });

  it('4. addresses !== undefined → replacePatientAddresses is called with the patient id', async () => {
    mockIdentityUpsert.mockResolvedValueOnce({ id: 'patient-r4', created: true });

    await service.upsertFromClickUp(
      makeInput({
        addresses: [
          { address_formatted: 'Av. Siempre Viva 742', address_type: 'primary' } as never,
        ],
      }),
    );

    expect(mockReplacePatientAddresses).toHaveBeenCalledTimes(1);
    expect(mockReplacePatientAddresses.mock.calls[0][0]).toBe('patient-r4');
  });

  it('5. professionals !== undefined → replacePatientProfessionals is called with the patient id', async () => {
    mockIdentityUpsert.mockResolvedValueOnce({ id: 'patient-r5', created: true });

    await service.upsertFromClickUp(
      makeInput({
        professionals: [{ name: 'Dr. García' } as never],
      }),
    );

    expect(mockReplacePatientProfessionals).toHaveBeenCalledTimes(1);
    expect(mockReplacePatientProfessionals.mock.calls[0][0]).toBe('patient-r5');
  });

  it('6. addresses and professionals both undefined → neither writer is called', async () => {
    mockIdentityUpsert.mockResolvedValueOnce({ id: 'patient-r6', created: true });

    await service.upsertFromClickUp(makeInput());

    expect(mockReplacePatientAddresses).not.toHaveBeenCalled();
    expect(mockReplacePatientProfessionals).not.toHaveBeenCalled();
    expect(mockReplaceAll).not.toHaveBeenCalled();
  });
});
