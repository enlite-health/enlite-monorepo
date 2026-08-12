/**
 * ActivatePatientUseCase — Fase 2 Task 3 (plano-app-pacientes §6, decisão D5).
 *
 * Covers:
 *   c. activate creates ONE draft vacancy per active address and sets ACTIVE,
 *      all in one transaction (COMMIT once, no ROLLBACK).
 *   d. activate with 0 active addresses → NoActiveAddressError, nothing created
 *      (no INSERT, no status UPDATE), transaction rolled back.
 *   e. activate on an already-ACTIVE patient → idempotent no-op (alreadyActive,
 *      no INSERT, no status UPDATE — never duplicates vacancies).
 *   f. missing patient → PatientNotFoundError.
 */

// ── Mocks (before imports) ────────────────────────────────────────────────────

const mockClient = { query: jest.fn(), release: jest.fn() };
const mockConnect = jest.fn().mockResolvedValue(mockClient);

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn(() => ({
      getPool: jest.fn(() => ({ connect: mockConnect })),
    })),
  },
}));

// Reuse of the vacancy INSERT is proven by the controller/integration layers;
// here we stub it to keep the unit test focused on the activation orchestration.
const mockBuildInsertParams = jest.fn((p: Record<string, unknown>) => [
  p.vacancyNumber,
  p.case_number,
  p.patient_id,
  p.patient_address_id,
]);
jest.mock('@modules/matching', () => ({
  buildInsertQuery: jest.fn(() => 'INSERT INTO job_postings (...) VALUES (...) RETURNING *'),
  buildInsertParams: (p: Record<string, unknown>) => mockBuildInsertParams(p),
}));

jest.mock('firebase-functions', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import {
  ActivatePatientUseCase,
  PatientNotFoundError,
  NoActiveAddressError,
} from '../ActivatePatientUseCase';

// ── Query dispatcher ──────────────────────────────────────────────────────────

interface DispatchOpts {
  patientRow?: { id: string; status: string; case_number: number | null } | null;
  addressIds?: string[];
}

function programClient(opts: DispatchOpts): { seen: string[] } {
  const seen: string[] = [];
  let nextvalIdx = 0;
  let insertIdx = 0;

  mockClient.query.mockImplementation(async (sql: string) => {
    seen.push(sql);
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
    if (sql.includes('FROM patients') && sql.includes('FOR UPDATE')) {
      return opts.patientRow
        ? { rowCount: 1, rows: [opts.patientRow] }
        : { rowCount: 0, rows: [] };
    }
    if (sql.includes('FROM patient_addresses')) {
      const rows = (opts.addressIds ?? []).map((id) => ({ id }));
      return { rowCount: rows.length, rows };
    }
    if (sql.includes('nextval')) {
      return { rows: [{ vn: String(100 + nextvalIdx++) }] };
    }
    if (sql.includes('INSERT INTO job_postings')) {
      return { rows: [{ id: `vac-${++insertIdx}` }] };
    }
    if (sql.includes('UPDATE patients SET status')) {
      return { rowCount: 1, rows: [] };
    }
    return { rowCount: 0, rows: [] };
  });

  return { seen };
}

const countSql = (seen: string[], needle: string): number =>
  seen.filter((s) => s.includes(needle)).length;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ActivatePatientUseCase', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnect.mockResolvedValue(mockClient);
  });

  it('c. creates ONE draft vacancy per active address and sets ACTIVE (single transaction)', async () => {
    const { seen } = programClient({
      patientRow: { id: 'pat-1', status: 'PENDING_ADMISSION', case_number: 42 },
      addressIds: ['addr-1', 'addr-2'],
    });

    const result = await new ActivatePatientUseCase().execute('pat-1');

    expect(result).toEqual({
      patientId: 'pat-1',
      status: 'ACTIVE',
      createdVacancyIds: ['vac-1', 'vac-2'],
      alreadyActive: false,
    });

    // one INSERT per address
    expect(countSql(seen, 'INSERT INTO job_postings')).toBe(2);
    // title uses the patient's case_number + the sequence value
    expect(mockBuildInsertParams).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        patient_id: 'pat-1',
        patient_address_id: 'addr-1',
        case_number: 42,
        computedTitle: 'CASO 42-100',
      }),
    );
    // status moved to ACTIVE, in the same tx, committed once, never rolled back
    expect(countSql(seen, "UPDATE patients SET status = 'ACTIVE'")).toBe(1);
    expect(countSql(seen, 'COMMIT')).toBe(1);
    expect(countSql(seen, 'ROLLBACK')).toBe(0);
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it('d. with 0 active addresses → NoActiveAddressError, nothing created, rolled back', async () => {
    const { seen } = programClient({
      patientRow: { id: 'pat-2', status: 'PENDING_ADMISSION', case_number: 7 },
      addressIds: [],
    });

    await expect(new ActivatePatientUseCase().execute('pat-2')).rejects.toBeInstanceOf(
      NoActiveAddressError,
    );

    expect(countSql(seen, 'INSERT INTO job_postings')).toBe(0);
    expect(countSql(seen, 'UPDATE patients SET status')).toBe(0);
    expect(countSql(seen, 'ROLLBACK')).toBe(1);
    expect(countSql(seen, 'COMMIT')).toBe(0);
  });

  it('e. already-ACTIVE patient → idempotent no-op, never duplicates vacancies', async () => {
    const { seen } = programClient({
      patientRow: { id: 'pat-3', status: 'ACTIVE', case_number: 9 },
      addressIds: ['addr-x'],
    });

    const result = await new ActivatePatientUseCase().execute('pat-3');

    expect(result).toEqual({
      patientId: 'pat-3',
      status: 'ACTIVE',
      createdVacancyIds: [],
      alreadyActive: true,
    });

    // never even looked at addresses, never inserted, never moved status
    expect(countSql(seen, 'FROM patient_addresses')).toBe(0);
    expect(countSql(seen, 'INSERT INTO job_postings')).toBe(0);
    expect(countSql(seen, 'UPDATE patients SET status')).toBe(0);
    expect(countSql(seen, 'ROLLBACK')).toBe(1);
  });

  it('f. missing patient → PatientNotFoundError', async () => {
    programClient({ patientRow: null });

    await expect(new ActivatePatientUseCase().execute('ghost')).rejects.toBeInstanceOf(
      PatientNotFoundError,
    );
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });
});
