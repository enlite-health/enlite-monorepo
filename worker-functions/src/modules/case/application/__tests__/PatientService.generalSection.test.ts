/**
 * PatientService.updatePatientSection('general') + updateGeneralSection.
 *
 * Covers previously-uncovered lines:
 *  1. updatePatientSection('general', ...) delegates to updateGeneralSection.
 *  2. updateGeneralSection: column whitelist — only keys present in `data`
 *     are set (partial update).
 *  3. updateGeneralSection: contactEmail branch encrypts via KMS and adds
 *     contact_email_encrypted to the SET clause.
 *  4. updateGeneralSection: sets.length === 0 → returns without querying
 *     (data = {} — no whitelisted key present).
 *  5. updatePatientSection: generic error inside the switch → ROLLBACK + rethrow.
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

jest.mock('firebase-functions', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { PatientService, type PatientGeneralSectionData } from '../PatientService';
import { PatientResponsibleRepository } from '../../infrastructure/PatientResponsibleRepository';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PatientService.updatePatientSection(general) / updateGeneralSection', () => {
  let service: PatientService;

  beforeEach(() => {
    jest.clearAllMocks();
    _queryImpl = async () => undefined;
    mockGetClient.mockResolvedValue(mockClient);
    service = new PatientService();
  });

  it('1+2. updates only the fields present in data (partial whitelist)', async () => {
    const seen: Array<{ sql: string; params?: unknown[] }> = [];
    _queryImpl = async (sql: string, params?: unknown[]) => {
      seen.push({ sql, params });
      return undefined;
    };

    const data: PatientGeneralSectionData = {
      firstName: 'Nuevo',
      phoneWhatsapp: '+5491100000099',
    };

    const result = await service.updatePatientSection('pid-general-1', 'general', data);

    expect(result).toEqual({ id: 'pid-general-1', updated: true });
    const update = seen.find((s) => s.sql.startsWith('UPDATE patients SET'));
    expect(update).toBeDefined();
    expect(update!.sql).toContain('first_name = $2');
    expect(update!.sql).toContain('phone_whatsapp = $3');
    // Fields NOT present in data must not appear in the SET clause.
    expect(update!.sql).not.toContain('last_name');
    expect(update!.sql).not.toContain('document_number');
    expect(update!.params).toEqual(['pid-general-1', 'Nuevo', '+5491100000099']);
  });

  it('2b. a whitelisted key present with value null is still set (?? null passthrough)', async () => {
    const seen: Array<{ sql: string; params?: unknown[] }> = [];
    _queryImpl = async (sql: string, params?: unknown[]) => {
      seen.push({ sql, params });
      return undefined;
    };

    await service.updatePatientSection('pid-general-2', 'general', { affiliateId: null });

    const update = seen.find((s) => s.sql.startsWith('UPDATE patients SET'));
    expect(update!.sql).toContain('affiliate_id = $2');
    expect(update!.params).toEqual(['pid-general-2', null]);
  });

  it('3. contactEmail present → encrypted via KMS and set as contact_email_encrypted', async () => {
    const seen: Array<{ sql: string; params?: unknown[] }> = [];
    _queryImpl = async (sql: string, params?: unknown[]) => {
      seen.push({ sql, params });
      return undefined;
    };

    await service.updatePatientSection('pid-general-3', 'general', {
      contactEmail: 'novo@example.com',
    });

    expect(mockEncrypt).toHaveBeenCalledWith('novo@example.com');
    const update = seen.find((s) => s.sql.startsWith('UPDATE patients SET'));
    expect(update!.sql).toContain('contact_email_encrypted = $2');
    expect(update!.params![1]).toBe(Buffer.from('novo@example.com', 'utf8').toString('base64'));
  });

  it('3b. contactEmail explicitly null → still encrypts (null) and sets contact_email_encrypted', async () => {
    const seen: Array<{ sql: string; params?: unknown[] }> = [];
    _queryImpl = async (sql: string, params?: unknown[]) => {
      seen.push({ sql, params });
      return undefined;
    };

    await service.updatePatientSection('pid-general-3b', 'general', { contactEmail: null });

    expect(mockEncrypt).toHaveBeenCalledWith(null);
    const update = seen.find((s) => s.sql.startsWith('UPDATE patients SET'));
    expect(update!.sql).toContain('contact_email_encrypted = $2');
    expect(update!.params![1]).toBeNull();
  });

  it('4. data = {} (no whitelisted key, no contactEmail) → returns without issuing UPDATE', async () => {
    const seen: string[] = [];
    _queryImpl = async (sql: string) => { seen.push(sql); return undefined; };

    const result = await service.updatePatientSection('pid-general-4', 'general', {});

    expect(result).toEqual({ id: 'pid-general-4', updated: true });
    expect(seen.some((s) => s.startsWith('UPDATE patients SET'))).toBe(false);
    // BEGIN/COMMIT still run around the no-op.
    expect(seen).toContain('BEGIN');
    expect(seen).toContain('COMMIT');
  });

  it('6. support-network with no `responsibles` key → replaceAll called with [] (?? [] branch)', async () => {
    _queryImpl = async () => undefined;
    const respInstance = (PatientResponsibleRepository as jest.Mock).mock.results[
      (PatientResponsibleRepository as jest.Mock).mock.results.length - 1
    ].value as { replaceAll: jest.Mock };

    await service.updatePatientSection('pid-general-6', 'support-network', {} as never);

    expect(respInstance.replaceAll).toHaveBeenCalledWith('pid-general-6', [], mockClient);
  });

  it('7. service section: serviceType undefined → UPDATE sets service_type = NULL', async () => {
    const seen: Array<{ sql: string; params?: unknown[] }> = [];
    _queryImpl = async (sql: string, params?: unknown[]) => { seen.push({ sql, params }); return undefined; };

    await service.updatePatientSection('pid-general-7', 'service', {} as never);

    const update = seen.find((s) => s.sql.includes('UPDATE patients SET service_type'));
    expect(update).toBeDefined();
    expect(update!.params).toEqual(['pid-general-7', null]);
  });

  it('8. service section: serviceType = [] (empty array) → UPDATE sets service_type = NULL', async () => {
    const seen: Array<{ sql: string; params?: unknown[] }> = [];
    _queryImpl = async (sql: string, params?: unknown[]) => { seen.push({ sql, params }); return undefined; };

    await service.updatePatientSection('pid-general-8', 'service', { serviceType: [] } as never);

    const update = seen.find((s) => s.sql.includes('UPDATE patients SET service_type'));
    expect(update!.params).toEqual(['pid-general-8', null]);
  });

  it('5. generic error inside the switch (clinical section) → ROLLBACK + rethrow', async () => {
    const rollbackCalls: string[] = [];
    _queryImpl = async (sql: string) => {
      if (sql === 'ROLLBACK') rollbackCalls.push('ROLLBACK');
      return undefined;
    };
    mockClinicalUpsert.mockRejectedValueOnce(new Error('clinical section write failed'));

    await expect(
      service.updatePatientSection('pid-general-5', 'clinical', { diagnosis: 'F84' } as never),
    ).rejects.toThrow('clinical section write failed');

    expect(rollbackCalls.length).toBeGreaterThanOrEqual(1);
    expect(mockClient.release).toHaveBeenCalled();
  });
});
