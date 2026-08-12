/**
 * PatientService — Native write path (migration 251) unit tests.
 *
 * Covers the Enlite-source-of-truth create/update methods, which are SEPARATE
 * from upsertFromClickUp (no ON CONFLICT, clickup_task_id NULL, explicit origin
 * + status). Non-regression of the ClickUp path lives in PatientService.test.ts
 * and is run alongside this file.
 *
 *  a. createNativePatient inserts with the right origin/status and hits the
 *     native (no-ON-CONFLICT) repo method, NOT the ClickUp upsert.
 *  b. moveStatus transitions status via UPDATE, never touching origin.
 *  c. moveStatus rejects an unknown status.
 *  d. createNativePatient encrypts the contact email via KMS.
 *  e. updatePatientSection('service') targets only service_type.
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

jest.mock('../../infrastructure/PatientClinicalRepository', () => ({
  PatientClinicalRepository: jest.fn().mockImplementation(() => ({
    upsert: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('../../infrastructure/PatientResponsibleRepository', () => ({
  PatientResponsibleRepository: jest.fn().mockImplementation(() => ({
    replaceAll: jest.fn().mockResolvedValue(undefined),
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

jest.mock('firebase-functions', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import {
  PatientService,
  type CreateNativePatientInput,
} from '../PatientService';
import { PatientIdentityRepository, type PatientIdentityNativeInsertInput } from '../../infrastructure/PatientIdentityRepository';
import { PatientResponsibleRepository } from '../../infrastructure/PatientResponsibleRepository';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PatientService — native write path (migration 251)', () => {
  let service: PatientService;
  let mockInsertNative: jest.Mock;
  let mockUpsert: jest.Mock;
  let mockReplaceAll: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    _queryImpl = async () => undefined;
    mockGetClient.mockResolvedValue(mockClient);

    service = new PatientService();

    const identityInstance = (PatientIdentityRepository as jest.Mock).mock.results[
      (PatientIdentityRepository as jest.Mock).mock.results.length - 1
    ].value as { upsert: jest.Mock; insertNative: jest.Mock };
    mockInsertNative = identityInstance.insertNative;
    mockUpsert       = identityInstance.upsert;

    const respInstance = (PatientResponsibleRepository as jest.Mock).mock.results[
      (PatientResponsibleRepository as jest.Mock).mock.results.length - 1
    ].value as { replaceAll: jest.Mock };
    mockReplaceAll = respInstance.replaceAll;
  });

  function makeNativeInput(overrides: Partial<CreateNativePatientInput> = {}): CreateNativePatientInput {
    return {
      firstName:     'Lucía',
      lastName:      'Fernández',
      phoneWhatsapp: '+5491100000000',
      ...overrides,
    } as CreateNativePatientInput;
  }

  // ── a. createNativePatient ────────────────────────────────────────────────

  it('a. creates with origin/status via insertNative (never the ClickUp upsert)', async () => {
    mockInsertNative.mockResolvedValueOnce({ id: 'nat-001', created: true });

    const result = await service.createNativePatient(makeNativeInput(), {
      origin: 'admin_manual',
      status: 'ADMISSION',
    });

    expect(result).toEqual({ id: 'nat-001', created: true });

    // native path only — the ClickUp ON CONFLICT upsert is never called
    expect(mockInsertNative).toHaveBeenCalledTimes(1);
    expect(mockUpsert).not.toHaveBeenCalled();

    const nativeArg = mockInsertNative.mock.calls[0][0] as PatientIdentityNativeInsertInput;
    expect(nativeArg.origin).toBe('admin_manual');
    expect(nativeArg.status).toBe('ADMISSION');
    // native input carries NO clickupTaskId (repo persists clickup_task_id NULL)
    expect((nativeArg as unknown as Record<string, unknown>)['clickupTaskId']).toBeUndefined();
  });

  it('a2. web_form lead with SOLICITANTE passes validation via patient email only', async () => {
    mockInsertNative.mockResolvedValueOnce({ id: 'nat-002', created: true });

    // no phone, no responsible — only the contact email. Must NOT throw.
    const result = await service.createNativePatient(
      makeNativeInput({ phoneWhatsapp: null }),
      { origin: 'web_form', status: 'SOLICITANTE', contactEmail: 'lead@example.com' },
    );

    expect(result.id).toBe('nat-002');
    const nativeArg = mockInsertNative.mock.calls[0][0] as PatientIdentityNativeInsertInput;
    expect(nativeArg.origin).toBe('web_form');
    expect(nativeArg.status).toBe('SOLICITANTE');
  });

  it('a3. throws when no contact channel at all (no phone, no email, no responsible)', async () => {
    await expect(
      service.createNativePatient(makeNativeInput({ phoneWhatsapp: null }), {
        origin: 'web_form',
        status: 'SOLICITANTE',
      }),
    ).rejects.toThrow(/contato/i);

    expect(mockInsertNative).not.toHaveBeenCalled();
  });

  // ── d. KMS encryption of contact email ────────────────────────────────────

  it('d. encrypts the contact email with KMS before storage', async () => {
    mockInsertNative.mockResolvedValueOnce({ id: 'nat-003', created: true });

    await service.createNativePatient(makeNativeInput(), {
      origin: 'web_form',
      status: 'SOLICITANTE',
      contactEmail: 'secret@example.com',
    });

    expect(mockEncrypt).toHaveBeenCalledWith('secret@example.com');
    const nativeArg = mockInsertNative.mock.calls[0][0] as PatientIdentityNativeInsertInput;
    // stored value is ciphertext (base64), never the plaintext
    expect(nativeArg.contactEmailEncrypted).toBe(
      Buffer.from('secret@example.com', 'utf8').toString('base64'),
    );
    expect(nativeArg.contactEmailEncrypted).not.toBe('secret@example.com');
  });

  // ── b. moveStatus ─────────────────────────────────────────────────────────

  it('b. moveStatus updates status and never touches origin', async () => {
    const seen: Array<{ sql: string; params?: unknown[] }> = [];
    _queryImpl = async (sql: string, params?: unknown[]) => {
      seen.push({ sql, params });
      if (sql.startsWith('UPDATE patients SET status')) {
        return { rowCount: 1, rows: [{ id: 'nat-004' }] };
      }
      return undefined;
    };

    const result = await service.moveStatus('nat-004', 'PENDING_ADMISSION');

    expect(result).toEqual({ id: 'nat-004', status: 'PENDING_ADMISSION' });
    const update = seen.find(s => s.sql.startsWith('UPDATE patients SET status'));
    expect(update).toBeDefined();
    expect(update!.sql).not.toContain('origin');
    expect(update!.params).toEqual(['nat-004', 'PENDING_ADMISSION']);
  });

  it('b2. moveStatus throws Patient not found when no row matches', async () => {
    _queryImpl = async (sql: string) =>
      sql.startsWith('UPDATE patients SET status') ? { rowCount: 0, rows: [] } : undefined;

    await expect(service.moveStatus('missing', 'ACTIVE')).rejects.toThrow(/not found/i);
  });

  // ── c. moveStatus validation ──────────────────────────────────────────────

  it('c. moveStatus rejects an unknown status', async () => {
    await expect(
      service.moveStatus('nat-005', 'NOT_A_STATUS' as never),
    ).rejects.toThrow(/Invalid patient status/);
  });

  // ── e. updatePatientSection('service') targets only service_type ──────────

  it('e. updatePatientSection(service) updates only service_type', async () => {
    const seen: string[] = [];
    _queryImpl = async (sql: string) => { seen.push(sql); return undefined; };

    await service.updatePatientSection('nat-006', 'service', {
      serviceType: ['CAREGIVER'] as never,
    });

    const update = seen.find(s => s.includes('UPDATE patients SET service_type'));
    expect(update).toBeDefined();
    expect(update).not.toContain('diagnosis');
  });

  it('e2. updatePatientSection(support-network) delegates to responsibleRepo.replaceAll', async () => {
    await service.updatePatientSection('nat-007', 'support-network', {
      responsibles: [
        { firstName: 'R', lastName: 'One', isPrimary: true, displayOrder: 1 },
      ],
    });

    expect(mockReplaceAll).toHaveBeenCalledTimes(1);
    expect(mockReplaceAll.mock.calls[0][0]).toBe('nat-007');
  });
});
