/**
 * PatientService — conflict-retry branches (native + ClickUp paths).
 *
 * Covers previously-uncovered lines:
 *  1. createNativePatient: insertNative throws 23505 → retries via
 *     retryNativeWithoutCaseNumber → second insertNative succeeds
 *     (native_case_number_conflict_retry log + happy path of the retry fn).
 *  2. retryNativeWithoutCaseNumber: the RETRY itself fails (generic DB error)
 *     → ROLLBACK + rethrow.
 *  3. runNativeCreateTransaction: insertNative succeeds but upsertRelated
 *     (clinicalRepo.upsert) throws → ROLLBACK + rethrow (never released twice).
 *  4. runUpsertTransaction (ClickUp path): after the first 23505 triggers
 *     retryWithoutCaseNumber, the retry's OWN identityRepo.upsert also fails
 *     → ROLLBACK + rethrow inside retryWithoutCaseNumber.
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
      getPool:   jest.fn(() => ({ connect: mockGetClient })),
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
import { PatientIdentityRepository, type PatientIdentityNativeInsertInput } from '../../infrastructure/PatientIdentityRepository';

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

describe('PatientService — native case_number conflict retry', () => {
  let service: PatientService;
  let mockInsertNative: jest.Mock;
  let mockUpsert: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    _queryImpl = async () => undefined;
    mockGetClient.mockResolvedValue(mockClient);
    mockClinicalUpsert.mockResolvedValue(undefined);

    service = new PatientService();

    const identityInstance = (PatientIdentityRepository as jest.Mock).mock.results[
      (PatientIdentityRepository as jest.Mock).mock.results.length - 1
    ].value as { upsert: jest.Mock; insertNative: jest.Mock };
    mockInsertNative = identityInstance.insertNative;
    mockUpsert       = identityInstance.upsert;
  });

  it('1. insertNative throws 23505 → retries without caseNumber and succeeds', async () => {
    mockInsertNative
      .mockRejectedValueOnce(makePgUniqueError())
      .mockResolvedValueOnce({ id: 'nat-retry-1', created: true });

    const result = await service.createNativePatient(makeNativeInput(), {
      origin: 'admin_manual',
      status: 'ADMISSION',
    });

    expect(result).toEqual({ id: 'nat-retry-1', created: true });
    expect(mockInsertNative).toHaveBeenCalledTimes(2);
    expect(mockUpsert).not.toHaveBeenCalled();

    const retryArg = mockInsertNative.mock.calls[1][0] as PatientIdentityNativeInsertInput;
    expect(retryArg.caseNumber).toBeNull();
    expect(retryArg.needsAttention).toBe(true);
    expect(retryArg.attentionReasons).toContain('CASE_NUMBER_CONFLICT');

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'patient_service.native_case_number_conflict_retry',
      expect.objectContaining({ origin: 'admin_manual', rejectedCaseNumber: 77 }),
    );
  });

  it('2. retry itself fails with a generic DB error → ROLLBACK + rethrow', async () => {
    const rollbackCalls: string[] = [];
    _queryImpl = async (sql: string) => {
      if (sql === 'ROLLBACK') rollbackCalls.push('ROLLBACK');
      return undefined;
    };

    mockInsertNative
      .mockRejectedValueOnce(makePgUniqueError())
      .mockRejectedValueOnce(new Error('connection lost mid-retry'));

    await expect(
      service.createNativePatient(makeNativeInput(), { origin: 'web_form', status: 'SOLICITANTE' }),
    ).rejects.toThrow('connection lost mid-retry');

    expect(mockInsertNative).toHaveBeenCalledTimes(2);
    expect(rollbackCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('1b. insertNative throws a NON-conflict error → rethrows directly, no retry', async () => {
    mockInsertNative.mockRejectedValueOnce(new Error('constraint violation unrelated to case_number'));

    await expect(
      service.createNativePatient(makeNativeInput(), { origin: 'admin_manual', status: 'ADMISSION' }),
    ).rejects.toThrow('constraint violation unrelated to case_number');

    expect(mockInsertNative).toHaveBeenCalledTimes(1);
  });

  it('3. insertNative succeeds but upsertRelated (clinicalRepo.upsert) fails → ROLLBACK + rethrow', async () => {
    const rollbackCalls: string[] = [];
    _queryImpl = async (sql: string) => {
      if (sql === 'ROLLBACK') rollbackCalls.push('ROLLBACK');
      return undefined;
    };

    mockInsertNative.mockResolvedValueOnce({ id: 'nat-related-fail', created: true });
    mockClinicalUpsert.mockRejectedValueOnce(new Error('clinical write failed'));

    await expect(
      service.createNativePatient(makeNativeInput(), { origin: 'admin_manual', status: 'ADMISSION' }),
    ).rejects.toThrow('clinical write failed');

    expect(rollbackCalls.length).toBeGreaterThanOrEqual(1);
    expect(mockClient.release).toHaveBeenCalled();
  });
});

describe('PatientService — ClickUp path: retryWithoutCaseNumber itself fails', () => {
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

  it('4. first upsert throws 23505, the retry upsert also throws (generic) → ROLLBACK + rethrow', async () => {
    const rollbackCalls: string[] = [];
    _queryImpl = async (sql: string) => {
      if (sql === 'ROLLBACK') rollbackCalls.push('ROLLBACK');
      return undefined;
    };

    mockIdentityUpsert
      .mockRejectedValueOnce(makePgUniqueError())
      .mockRejectedValueOnce(new Error('retry also failed'));

    await expect(service.upsertFromClickUp(makeClickUpInput())).rejects.toThrow('retry also failed');

    expect(mockIdentityUpsert).toHaveBeenCalledTimes(2);
    expect(rollbackCalls.length).toBeGreaterThanOrEqual(1);
  });
});

// NOTE: isCaseNumberConflict edge branches, moveStatus rowCount branch, and
// the caseNumber-undefined (?? null) branches are covered in
// PatientService.native3.test.ts (split out to respect the 400-line cap).
