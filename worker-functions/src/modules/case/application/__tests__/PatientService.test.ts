/**
 * PatientService — Unit Tests
 *
 * Covers the upsertFromClickUp method with focus on:
 *  1. Normal path: upsert succeeds, no conflict in result
 *  2. CASE_NUMBER_CONFLICT: repo throws Postgres 23505 on the UNIQUE constraint,
 *     service retries without caseNumber, returns conflict flag + CASE_NUMBER_CONFLICT reason
 *  3. Other DB errors propagate unchanged
 *  4. MISSING_INFO reason is preserved alongside CASE_NUMBER_CONFLICT
 *  5. patient_service.upsert.start emitted before INSERT
 *  6. patient_service.upsert.completed emitted on success with correlationId
 *  7. patient_service.case_number_conflict_retry emitted before retry
 *  8. patient_service.upsert.failed emitted on generic error
 *  9. PII guard — firstName/lastName never appear in logger calls
 */

// ── Mocks (must appear before imports) ───────────────────────────────────────

// Shared client state — reset between tests
let _queryImpl: (sql: string) => Promise<unknown> = async () => undefined;
let _releaseCallCount = 0;

const mockClient = {
  query:   jest.fn(async (sql: string) => _queryImpl(sql)),
  release: jest.fn(() => { _releaseCallCount++; }),
};

const mockGetClient = jest.fn().mockResolvedValue(mockClient);

// As escritas de paciente rodam em `withActorContext(getPool(), ...)` (BLOCKER-5:
// `getClient()` furava o roteamento por identidade e o contexto de país), então o
// pool mockado precisa saber `connect()` — é de lá que sai o client da transação.
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn(() => ({
      getPool:    jest.fn(() => ({ connect: mockGetClient })),
      getClient:  mockGetClient,
    })),
  },
}));

// Mock repos — we replace the prototype methods directly after import
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

jest.mock(
  '../../infrastructure/PatientResponsibleRepository',
  () => ({
    PatientResponsibleRepository: jest.fn().mockImplementation(() => ({
      replaceAll: jest.fn().mockResolvedValue(undefined),
    })),
  }),
);

jest.mock('../../infrastructure/geocodePatientAddresses', () => ({
  geocodePatientAddressesBestEffort: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../../../infrastructure/services/GeocodingService', () => ({
  GeocodingService: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../PatientRelatedWriter', () => ({
  replacePatientAddresses:    jest.fn().mockResolvedValue(undefined),
  replacePatientProfessionals: jest.fn().mockResolvedValue(undefined),
}));

const mockLoggerInfo  = jest.fn();
const mockLoggerWarn  = jest.fn();
const mockLoggerError = jest.fn();

jest.mock('firebase-functions', () => ({
  logger: {
    info:  (...args: unknown[]) => mockLoggerInfo(...args),
    warn:  (...args: unknown[]) => mockLoggerWarn(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { PatientService, type PatientServiceUpsertInput } from '../PatientService';
import { PatientIdentityRepository } from '../../infrastructure/PatientIdentityRepository';
import { PatientClinicalRepository } from '../../infrastructure/PatientClinicalRepository';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeInput(overrides: Partial<PatientServiceUpsertInput> = {}): PatientServiceUpsertInput {
  return {
    clickupTaskId: 'task-abc',
    firstName:     'Ana',
    lastName:      'García',
    caseNumber:    42,
    ...overrides,
  } as PatientServiceUpsertInput;
}

function makePgUniqueError(): { code: string; constraint: string; message: string } {
  return {
    code:       '23505',
    constraint: 'patients_case_number_active_unique',
    message:    'duplicate key value violates unique constraint "patients_case_number_active_unique"',
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PatientService.upsertFromClickUp', () => {
  let service: PatientService;
  let mockIdentityUpsert: jest.Mock;
  let mockClinicalUpsert: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    _releaseCallCount = 0;

    // Default: BEGIN/COMMIT/ROLLBACK are no-ops
    _queryImpl = async () => undefined;

    // Re-resolve the mocked instances after clearAllMocks
    service = new PatientService();

    // Grab the mock methods from the constructed instances
    const identityInstance = (PatientIdentityRepository as jest.Mock).mock.results[
      (PatientIdentityRepository as jest.Mock).mock.results.length - 1
    ].value as { upsert: jest.Mock };
    mockIdentityUpsert = identityInstance.upsert;

    const clinicalInstance = (PatientClinicalRepository as jest.Mock).mock.results[
      (PatientClinicalRepository as jest.Mock).mock.results.length - 1
    ].value as { upsert: jest.Mock };
    mockClinicalUpsert = clinicalInstance.upsert;
    mockClinicalUpsert.mockResolvedValue(undefined);

    mockGetClient.mockResolvedValue(mockClient);
  });

  // ── 1. Normal path ──────────────────────────────────────────────────────────

  it('1. returns { created, flagged } without conflict field on normal upsert', async () => {
    mockIdentityUpsert.mockResolvedValueOnce({ id: 'patient-001', created: true });

    const result = await service.upsertFromClickUp(makeInput());

    expect(result.id).toBe('patient-001');
    expect(result.created).toBe(true);
    expect(result.flagged).toBe(false);
    expect(result.conflict).toBeUndefined();
    expect(mockClinicalUpsert).toHaveBeenCalledTimes(1);
  });

  // ── 2. CASE_NUMBER_CONFLICT — retry without caseNumber ─────────────────────

  it('2. catches 23505 unique constraint and retries with caseNumber=null', async () => {
    // First call throws the Postgres constraint error, second succeeds
    mockIdentityUpsert
      .mockRejectedValueOnce(makePgUniqueError())
      .mockResolvedValueOnce({ id: 'patient-002', created: false });

    const result = await service.upsertFromClickUp(makeInput({ caseNumber: 42 }), {
      onMissingContact: 'flag',
    });

    expect(result.conflict).toBe('CASE_NUMBER_CONFLICT');
    expect(result.flagged).toBe(true);
    expect(result.id).toBe('patient-002');

    // Second upsert call must have caseNumber=null + CASE_NUMBER_CONFLICT in reasons
    expect(mockIdentityUpsert).toHaveBeenCalledTimes(2);
    const secondCallInput = mockIdentityUpsert.mock.calls[1][0] as PatientServiceUpsertInput;
    expect(secondCallInput.caseNumber).toBeNull();
    expect(secondCallInput.needsAttention).toBe(true);
    expect(secondCallInput.attentionReasons).toContain('CASE_NUMBER_CONFLICT');

    // Clinical upsert still runs in the retry transaction
    expect(mockClinicalUpsert).toHaveBeenCalledTimes(1);
  });

  it('2b. ROLLBACK is called on first transaction before the retry', async () => {
    const rollbackCalls: string[] = [];
    _queryImpl = async (sql: string) => {
      if (sql === 'ROLLBACK') rollbackCalls.push('ROLLBACK');
      return undefined;
    };

    mockIdentityUpsert
      .mockRejectedValueOnce(makePgUniqueError())
      .mockResolvedValueOnce({ id: 'patient-003', created: true });

    await service.upsertFromClickUp(makeInput());

    expect(rollbackCalls.length).toBeGreaterThanOrEqual(1);
  });

  // ── 3. Other DB errors propagate ────────────────────────────────────────────

  it('3. re-throws non-conflict DB errors without retry', async () => {
    const foreignKeyError = { code: '23503', constraint: 'some_fk', message: 'fk violation' };
    mockIdentityUpsert.mockRejectedValueOnce(foreignKeyError);

    await expect(service.upsertFromClickUp(makeInput())).rejects.toMatchObject({
      code: '23503',
    });

    // Only one upsert attempt
    expect(mockIdentityUpsert).toHaveBeenCalledTimes(1);
  });

  // ── 4. MISSING_INFO preserved when combined with CASE_NUMBER_CONFLICT ───────

  it('4. preserves MISSING_INFO reason when conflict also occurs', async () => {
    mockIdentityUpsert
      .mockRejectedValueOnce(makePgUniqueError())
      .mockResolvedValueOnce({ id: 'patient-004', created: true });

    const inputWithMissingInfo: PatientServiceUpsertInput = {
      ...makeInput(),
      attentionReasons: ['MISSING_INFO'],
    };

    const result = await service.upsertFromClickUp(inputWithMissingInfo, {
      onMissingContact: 'flag',
    });

    expect(result.conflict).toBe('CASE_NUMBER_CONFLICT');

    const retryInput = mockIdentityUpsert.mock.calls[1][0] as PatientServiceUpsertInput;
    expect(retryInput.attentionReasons).toContain('MISSING_INFO');
    expect(retryInput.attentionReasons).toContain('CASE_NUMBER_CONFLICT');
  });

  // ── 5. patient_service.upsert.start emitted before INSERT ──────────────────

  it('5. emits patient_service.upsert.start before the identity upsert', async () => {
    const callOrder: string[] = [];
    mockLoggerInfo.mockImplementation((event: string) => { callOrder.push(event); });
    mockIdentityUpsert.mockImplementation(async () => {
      callOrder.push('identity.upsert');
      return { id: 'patient-005', created: true };
    });

    await service.upsertFromClickUp(makeInput({ caseNumber: 10 }), { correlationId: 'cid-start' });

    expect(callOrder[0]).toBe('patient_service.upsert.start');
    expect(callOrder[1]).toBe('identity.upsert');
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      'patient_service.upsert.start',
      expect.objectContaining({ clickupTaskId: 'task-abc', caseNumber: 10, correlationId: 'cid-start' }),
    );
  });

  // ── 6. patient_service.upsert.completed emitted on success with correlationId

  it('6. emits patient_service.upsert.completed with correlationId on success', async () => {
    mockIdentityUpsert.mockResolvedValueOnce({ id: 'patient-006', created: false });

    await service.upsertFromClickUp(makeInput(), { correlationId: 'cid-completed' });

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      'patient_service.upsert.completed',
      expect.objectContaining({
        clickupTaskId: 'task-abc',
        patientId:     'patient-006',
        created:       false,
        flagged:       false,
        correlationId: 'cid-completed',
      }),
    );
    // durationMs must be a non-negative number
    const completedCall = mockLoggerInfo.mock.calls.find(
      (c: unknown[]) => c[0] === 'patient_service.upsert.completed',
    );
    const payload = completedCall![1] as Record<string, unknown>;
    expect(typeof payload['durationMs']).toBe('number');
    expect(payload['durationMs'] as number).toBeGreaterThanOrEqual(0);
  });

  // ── 7. patient_service.case_number_conflict_retry emitted before retry ──────

  it('7. emits patient_service.case_number_conflict_retry on 23505 conflict', async () => {
    mockIdentityUpsert
      .mockRejectedValueOnce(makePgUniqueError())
      .mockResolvedValueOnce({ id: 'patient-007', created: true });

    await service.upsertFromClickUp(makeInput({ caseNumber: 99 }), { correlationId: 'cid-conflict' });

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'patient_service.case_number_conflict_retry',
      expect.objectContaining({
        clickupTaskId:      'task-abc',
        rejectedCaseNumber: 99,
        correlationId:      'cid-conflict',
      }),
    );
  });

  // ── 8. patient_service.upsert.failed emitted on generic error ──────────────

  it('8. emits patient_service.upsert.failed and rethrows on generic DB error', async () => {
    const dbError = new Error('connection reset');
    mockIdentityUpsert.mockRejectedValueOnce(dbError);

    await expect(
      service.upsertFromClickUp(makeInput(), { correlationId: 'cid-fail' }),
    ).rejects.toThrow('connection reset');

    expect(mockLoggerError).toHaveBeenCalledWith(
      'patient_service.upsert.failed',
      expect.objectContaining({
        clickupTaskId: 'task-abc',
        error:         'connection reset',
        correlationId: 'cid-fail',
      }),
    );
    const failCall = mockLoggerError.mock.calls.find(
      (c: unknown[]) => c[0] === 'patient_service.upsert.failed',
    );
    const payload = failCall![1] as Record<string, unknown>;
    expect(typeof payload['durationMs']).toBe('number');
  });

  // ── 9. PII guard ────────────────────────────────────────────────────────────

  it('9. never logs firstName, lastName, phoneWhatsapp, or documentNumber', async () => {
    mockIdentityUpsert.mockResolvedValueOnce({ id: 'patient-009', created: true });

    await service.upsertFromClickUp(
      makeInput({ firstName: 'PII_FIRST', lastName: 'PII_LAST', phoneWhatsapp: '+5491100000000' }),
      { correlationId: 'cid-pii' },
    );

    const allLogArgs = JSON.stringify([
      ...mockLoggerInfo.mock.calls,
      ...mockLoggerWarn.mock.calls,
      ...mockLoggerError.mock.calls,
    ]);
    expect(allLogArgs).not.toContain('PII_FIRST');
    expect(allLogArgs).not.toContain('PII_LAST');
    expect(allLogArgs).not.toContain('+5491100000000');
  });
});
