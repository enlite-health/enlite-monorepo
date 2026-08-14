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

// Ver PatientService.test.ts: a transação sai de `getPool().connect()` agora.
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

  // No `as` cast: the compiler must enforce the required `country` here the
  // same way it does for production callers (D108 — the old cast let the whole
  // suite run with country undefined).
  function makeNativeInput(overrides: Partial<CreateNativePatientInput> = {}): CreateNativePatientInput {
    return {
      firstName:     'Lucía',
      lastName:      'Fernández',
      phoneWhatsapp: '+5491100000000',
      country:       'AR',
      ...overrides,
    };
  }

  // ── a. createNativePatient ────────────────────────────────────────────────

  it('a. creates with origin/status via insertNative (never the ClickUp upsert)', async () => {
    mockInsertNative.mockResolvedValueOnce({ id: 'nat-001', created: true });

    const result = await service.createNativePatient(makeNativeInput(), {
      origin: 'admin_manual',
      status: 'ADMISSION',
    });

    expect(result).toEqual({ id: 'nat-001', created: true });
    // The jurisdiction must reach the INSERT verbatim (D108).
    expect(mockInsertNative.mock.calls[0][0].country).toBe('AR');

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

  // ── f. retry de case_number no caminho NATIVO ─────────────────────────────
  //
  // A sentinela `CaseNumberConflictRetry` atravessa a fronteira da transação
  // (a que bateu na constraint está abortada no Postgres) e o retry abre uma
  // transação NOVA. O modo de falha disso é silencioso e tem forma de dado —
  // paciente sem criar, criado 2x, ou sem o CASE_NUMBER_CONFLICT que a operação
  // usa para filtrar — por isso cada perna tem teste (achado do gate 14/08).

  const CASE_NUMBER_CONFLICT_ERR = Object.assign(new Error('duplicate key'), {
    code: '23505',
    constraint: 'patients_case_number_active_unique',
  });

  it('f1. conflito de case_number → retry em transação NOVA, sem case_number e sinalizado', async () => {
    mockInsertNative
      .mockRejectedValueOnce(CASE_NUMBER_CONFLICT_ERR)
      .mockResolvedValueOnce({ id: 'nat-retry-1', created: true });

    const result = await service.createNativePatient(makeNativeInput({ caseNumber: 4711 }), {
      origin: 'admin_manual',
      status: 'ADMISSION',
    });

    expect(result).toEqual({ id: 'nat-retry-1', created: true });
    expect(mockInsertNative).toHaveBeenCalledTimes(2);

    // 1ª tentativa levou o case_number pedido; a transação dela deu ROLLBACK.
    expect((mockInsertNative.mock.calls[0][0] as PatientIdentityNativeInsertInput).caseNumber).toBe(4711);
    const sqls = mockClient.query.mock.calls.map((c) => String(c[0]));
    expect(sqls).toContain('ROLLBACK');

    // Retry: SEM case_number, marcado para revisão operacional, e em transação
    // NOVA (segundo connect no pool — a abortada não serve para mais nada).
    const retryArg = mockInsertNative.mock.calls[1][0] as PatientIdentityNativeInsertInput;
    expect(retryArg.caseNumber).toBeNull();
    expect(retryArg.needsAttention).toBe(true);
    expect(retryArg.attentionReasons).toContain('CASE_NUMBER_CONFLICT');
    expect(mockGetClient).toHaveBeenCalledTimes(2);
    expect(sqls.filter((s) => s === 'COMMIT')).toHaveLength(1);
  });

  it('f2. erro que NÃO é o conflito de case_number propaga sem retry', async () => {
    // Mesmo 23505, mas de OUTRA constraint (bloco clínico) — não é o sinal.
    const otherUnique = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'patient_clinical_pkey',
    });
    mockInsertNative.mockRejectedValueOnce(otherUnique);

    await expect(
      service.createNativePatient(makeNativeInput({ caseNumber: 4711 }), {
        origin: 'admin_manual',
        status: 'ADMISSION',
      }),
    ).rejects.toBe(otherUnique);

    expect(mockInsertNative).toHaveBeenCalledTimes(1);
    expect(mockGetClient).toHaveBeenCalledTimes(1); // nenhuma transação extra
  });

  it('f3. conflito TAMBÉM no retry propaga cru — uma tentativa só, nunca loop', async () => {
    mockInsertNative
      .mockRejectedValueOnce(CASE_NUMBER_CONFLICT_ERR)
      .mockRejectedValueOnce(CASE_NUMBER_CONFLICT_ERR);

    await expect(
      service.createNativePatient(makeNativeInput({ caseNumber: 4711 }), {
        origin: 'admin_manual',
        status: 'ADMISSION',
      }),
    ).rejects.toBe(CASE_NUMBER_CONFLICT_ERR);

    // Exatamente 2 tentativas (original + retry) — o retry não re-arma o retry.
    expect(mockInsertNative).toHaveBeenCalledTimes(2);
  });
});
