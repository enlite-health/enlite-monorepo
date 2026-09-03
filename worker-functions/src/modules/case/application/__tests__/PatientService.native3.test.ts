/**
 * PatientService — edge branches split out of PatientService.native2.test.ts
 * to keep each test file under the 400-line convention.
 *
 * Covers:
 *  5-7. isCaseNumberConflict type-guard edge branches (non-object / null /
 *       wrong constraint thrown by the identity repo).
 *  8.   moveStatus — rowCount ?? 0 nullish branch (driver omits rowCount).
 *  9.   upsertFromClickUp — caseNumber undefined (?? null branch on the
 *       conflict-retry warn log).
 *  10-11. createNativePatient — caseNumber undefined (?? null branch) and
 *       the primary-finder callback when `responsibles` is present.
 */

// ── Mocks (must appear before imports) ───────────────────────────────────────

let _queryImpl: (sql: string, params?: unknown[]) => Promise<unknown> = async () => undefined;

const mockClient = {
  query:   jest.fn(async (sql: string, params?: unknown[]) => _queryImpl(sql, params)),
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

const mockEncrypt = jest.fn(async (v: string | null | undefined) =>
  v ? Buffer.from(v, 'utf8').toString('base64') : null,
);

jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({
    encrypt: mockEncrypt,
    decrypt: jest.fn(),
  })),
}));

jest.mock('../../infrastructure/PatientIdentityRepository', () => ({
  PatientIdentityRepository: jest.fn().mockImplementation(() => ({
    upsert:       jest.fn(),
    insertNative: jest.fn(),
  })),
}));

const mockClinicalUpsert = jest.fn().mockResolvedValue(undefined);
jest.mock('../../infrastructure/PatientClinicalRepository', () => ({
  PatientClinicalRepository: jest.fn().mockImplementation(() => ({
    upsert: (...args: unknown[]) => mockClinicalUpsert(...args),
  })),
}));

jest.mock('../../infrastructure/PatientResponsibleRepository', () => ({
  PatientResponsibleRepository: jest.fn().mockImplementation(() => ({
    replaceAll: jest.fn().mockResolvedValue(undefined),
    replaceBySource: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('../../infrastructure/geocodePatientAddresses', () => ({
  geocodePatientAddressesBestEffort: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../../../infrastructure/services/GeocodingService', () => ({
  GeocodingService: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../PatientRelatedWriter', () => ({
  replacePatientAddresses:     jest.fn().mockResolvedValue(undefined),
  replacePatientProfessionals: jest.fn().mockResolvedValue(undefined),
}));

const mockLoggerWarn = jest.fn();
jest.mock('firebase-functions', () => ({
  logger: {
    info: jest.fn(),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: jest.fn(),
  },
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import {
  PatientService,
  type CreateNativePatientInput,
  type PatientServiceUpsertInput,
} from '../PatientService';
import { PatientIdentityRepository } from '../../infrastructure/PatientIdentityRepository';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePgUniqueError(): { code: string; constraint: string; message: string } {
  return {
    code:       '23505',
    constraint: 'patients_case_number_active_unique',
    message:    'duplicate key value violates unique constraint "patients_case_number_active_unique"',
  };
}

function makeNativeInput(overrides: Partial<CreateNativePatientInput> = {}): CreateNativePatientInput {
  return {
    firstName:     'Lucía',
    lastName:      'Fernández',
    phoneWhatsapp: '+5491100000000',
    country:       'AR',
    caseNumber:    77,
    ...overrides,
  };
}

function makeClickUpInput(overrides: Partial<PatientServiceUpsertInput> = {}): PatientServiceUpsertInput {
  return {
    clickupTaskId: 'task-retry',
    firstName:     'Ana',
    lastName:      'García',
    caseNumber:    42,
    ...overrides,
  } as PatientServiceUpsertInput;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PatientService — isCaseNumberConflict edge branches (non-object / null / wrong constraint)', () => {
  let service: PatientService;
  let mockIdentityUpsert: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    _queryImpl = async () => undefined;
    mockGetClient.mockResolvedValue(mockClient);

    service = new PatientService();

    const identityInstance = (PatientIdentityRepository as jest.Mock).mock.results[
      (PatientIdentityRepository as jest.Mock).mock.results.length - 1
    ].value as { upsert: jest.Mock };
    mockIdentityUpsert = identityInstance.upsert;
  });

  it('5. a thrown STRING (non-object) is never treated as a conflict — rethrows as-is', async () => {
    mockIdentityUpsert.mockRejectedValueOnce('plain string failure');

    await expect(service.upsertFromClickUp(makeClickUpInput())).rejects.toBe('plain string failure');
    expect(mockIdentityUpsert).toHaveBeenCalledTimes(1);
  });

  it('6. a thrown null is never treated as a conflict — rethrows as-is', async () => {
    // eslint-disable-next-line prefer-promise-reject-errors
    mockIdentityUpsert.mockRejectedValueOnce(null);

    await expect(service.upsertFromClickUp(makeClickUpInput())).rejects.toBeNull();
    expect(mockIdentityUpsert).toHaveBeenCalledTimes(1);
  });

  it('7. code=23505 but a DIFFERENT constraint is never treated as a conflict — rethrows', async () => {
    const wrongConstraint = { code: '23505', constraint: 'some_other_unique', message: 'other unique violated' };
    mockIdentityUpsert.mockRejectedValueOnce(wrongConstraint);

    await expect(service.upsertFromClickUp(makeClickUpInput())).rejects.toMatchObject({
      constraint: 'some_other_unique',
    });
    expect(mockIdentityUpsert).toHaveBeenCalledTimes(1);
  });
});

// ── moveStatus — rowCount nullish branch ───────────────────────────────────────

describe('PatientService.moveStatus — rowCount ?? 0 nullish branch', () => {
  let service: PatientService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetClient.mockResolvedValue(mockClient);
    service = new PatientService();
  });

  it('8. rowCount undefined (driver did not report it) → treated as 0 → "not found"', async () => {
    // v2 (spec 012): a leitura do status atual (FOR UPDATE) é quem decide "not found".
    _queryImpl = async (sql: string) =>
      sql.startsWith('SELECT status FROM patients') ? { rows: [] } : { rows: [], rowCount: 0 };

    await expect(service.moveStatus('pid-rowcount', 'ACTIVE')).rejects.toThrow(/not found/i);
  });
});

// ── caseNumber ?? null — undefined branch on the ClickUp start/warn logs ──────

describe('PatientService.upsertFromClickUp — caseNumber undefined (?? null branch)', () => {
  let service: PatientService;
  let mockIdentityUpsert: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    _queryImpl = async () => undefined;
    mockGetClient.mockResolvedValue(mockClient);
    service = new PatientService();

    const identityInstance = (PatientIdentityRepository as jest.Mock).mock.results[
      (PatientIdentityRepository as jest.Mock).mock.results.length - 1
    ].value as { upsert: jest.Mock };
    mockIdentityUpsert = identityInstance.upsert;
  });

  it('9. caseNumber undefined on the initial input → conflict-retry warn logs rejectedCaseNumber=null', async () => {
    mockIdentityUpsert
      .mockRejectedValueOnce(makePgUniqueError())
      .mockResolvedValueOnce({ id: 'patient-no-case', created: true });

    await service.upsertFromClickUp(makeClickUpInput({ caseNumber: undefined }));

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'patient_service.case_number_conflict_retry',
      expect.objectContaining({ rejectedCaseNumber: null }),
    );
  });
});

describe('PatientService.createNativePatient — caseNumber undefined (?? null branch)', () => {
  let service: PatientService;
  let mockInsertNative: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    _queryImpl = async () => undefined;
    mockGetClient.mockResolvedValue(mockClient);
    service = new PatientService();

    const identityInstance = (PatientIdentityRepository as jest.Mock).mock.results[
      (PatientIdentityRepository as jest.Mock).mock.results.length - 1
    ].value as { upsert: jest.Mock; insertNative: jest.Mock };
    mockInsertNative = identityInstance.insertNative;
  });

  it('11. createNativePatient with `responsibles` present exercises the primary-finder callback', async () => {
    mockInsertNative.mockResolvedValueOnce({ id: 'nat-with-resp', created: true });

    const result = await service.createNativePatient(
      makeNativeInput({
        phoneWhatsapp: null,
        responsibles: [
          { firstName: 'María', lastName: 'López', phone: '+5491100000002', isPrimary: true, displayOrder: 1 },
        ],
      }),
      { origin: 'admin_manual', status: 'ADMISSION' },
    );

    expect(result.id).toBe('nat-with-resp');
    expect(mockInsertNative).toHaveBeenCalledTimes(1);
  });

  it('10. caseNumber undefined → native conflict-retry warn logs rejectedCaseNumber=null', async () => {
    mockInsertNative
      .mockRejectedValueOnce(makePgUniqueError())
      .mockResolvedValueOnce({ id: 'nat-no-case', created: true });

    await service.createNativePatient(makeNativeInput({ caseNumber: undefined }), {
      origin: 'admin_manual',
      status: 'ADMISSION',
    });

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'patient_service.native_case_number_conflict_retry',
      expect.objectContaining({ rejectedCaseNumber: null }),
    );
  });
});
