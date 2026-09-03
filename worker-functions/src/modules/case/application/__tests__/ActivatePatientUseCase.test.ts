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

  it('g. erro inesperado NÃO-Error (ex.: rejeição de string) → logga com String(err) e propaga; ROLLBACK', async () => {
    const { seen } = programClient({
      patientRow: { id: 'pat-boom', status: 'PENDING_ADMISSION', case_number: 1 },
      addressIds: ['addr-1'],
    });
    mockClient.query.mockImplementation(async (sql: string) => {
      seen.push(sql);
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
      if (sql.includes('FROM patients') && sql.includes('FOR UPDATE')) {
        return { rowCount: 1, rows: [{ id: 'pat-boom', status: 'PENDING_ADMISSION', case_number: 1 }] };
      }
      if (sql.includes('FROM patient_addresses')) return { rowCount: 1, rows: [{ id: 'addr-1' }] };
      if (sql.includes('nextval')) throw 'plain string rejection'; // eslint-disable-line no-throw-literal
      return { rowCount: 0, rows: [] };
    });

    await expect(new ActivatePatientUseCase().execute('pat-boom')).rejects.toBe(
      'plain string rejection',
    );
    expect(countSql(seen, 'ROLLBACK')).toBe(1);
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it('h. move para ACTIVE limpa on_hold_* e grava change_source=activate na mesma transação (QA 🟡2)', async () => {
    const { seen } = programClient({
      patientRow: { id: 'pat-oh', status: 'ON_HOLD', case_number: 55 },
      addressIds: ['addr-1'],
    });

    await new ActivatePatientUseCase().execute('pat-oh');

    const setConfigCalls = mockClient.query.mock.calls.filter(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes("set_config('app.change_source'"),
    );
    expect(setConfigCalls).toHaveLength(1);
    expect(setConfigCalls[0][1]).toEqual(['activate']);

    const updateCall = mockClient.query.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('UPDATE patients SET status'),
    );
    expect(updateCall[0]).toContain('on_hold_reason = NULL');
    expect(updateCall[0]).toContain('on_hold_note = NULL');

    // set_config roda ANTES do UPDATE, na mesma transação (o trigger 254 lê o setting no momento do UPDATE).
    const setConfigIdx = seen.findIndex((s) => s.includes("set_config('app.change_source'"));
    const updateIdx = seen.findIndex((s) => s.includes('UPDATE patients SET status'));
    expect(setConfigIdx).toBeGreaterThan(-1);
    expect(setConfigIdx).toBeLessThan(updateIdx);
  });

  // ── Ramos pré-existentes do arquivo, sem cobertura antes desta rodada (D200: 100% do
  // arquivo TOCADO, não só das linhas novas) ──────────────────────────────────────────

  it('i. driver devolve rowCount undefined para o SELECT do paciente (?? 0) → mesmo tratamento de "não achei"', async () => {
    mockClient.query.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
      if (sql.includes('FROM patients') && sql.includes('FOR UPDATE')) {
        return { rows: [] }; // rowCount ausente (undefined), não `0` explícito — é o outro lado do `??`
      }
      return { rowCount: 0, rows: [] };
    });

    await expect(new ActivatePatientUseCase().execute('pat-undef')).rejects.toBeInstanceOf(
      PatientNotFoundError,
    );
  });

  it('j. driver devolve rowCount undefined para o SELECT de endereços (?? 0) → NoActiveAddressError', async () => {
    mockClient.query.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
      if (sql.includes('FROM patients') && sql.includes('FOR UPDATE')) {
        return { rowCount: 1, rows: [{ id: 'pat-4', status: 'PENDING_ADMISSION', case_number: 3 }] };
      }
      if (sql.includes('FROM patient_addresses')) return { rows: [] }; // rowCount ausente
      return { rowCount: 0, rows: [] };
    });

    await expect(new ActivatePatientUseCase().execute('pat-4')).rejects.toBeInstanceOf(
      NoActiveAddressError,
    );
  });

  it('k. ROLLBACK do catch-de-fallback também falha (transação já fechada) → o erro original ainda propaga, sem 2ª exceção', async () => {
    mockClient.query.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN') return {};
      if (sql === 'ROLLBACK') throw new Error('connection terminated');
      if (sql.includes('FROM patients') && sql.includes('FOR UPDATE')) {
        return { rowCount: 1, rows: [{ id: 'pat-5', status: 'PENDING_ADMISSION', case_number: 3 }] };
      }
      if (sql.includes('FROM patient_addresses')) throw new Error('conexão caiu no meio do SELECT');
      return { rowCount: 0, rows: [] };
    });

    await expect(new ActivatePatientUseCase().execute('pat-5')).rejects.toThrow(
      'conexão caiu no meio do SELECT',
    );
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });
});
