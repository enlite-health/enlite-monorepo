/**
 * PatientQueryRepository — unit tests.
 *
 * Had ZERO coverage before this file (11.9% lines). Constructor calls
 * DatabaseConnection.getInstance().getPool(), so we mock that module the
 * same way PatientClinicalRepository.test.ts does.
 *
 * Covers:
 *   a. list() — SQL params order/positions, total from COUNT(*) OVER(),
 *      total=0 when 0 rows, row mapping (isTest coercion, addressesCount/
 *      caseNumber parseInt, SLA fields via derivePatientSla), all filter
 *      ternary branches (needs_attention true/false/absent).
 *   b. stats() — country present/absent, numeric coercion of every field.
 *   c. findDetailById() — delegates to fetchPatientDetail(pool, encSvc, id).
 */

const mockPoolQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: mockPoolQuery }) }) },
}));

jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({ encrypt: jest.fn(), decrypt: jest.fn() })),
}));

const mockFetchPatientDetail = jest.fn();
jest.mock('../PatientDetailQueryHelper', () => ({
  fetchPatientDetail: (...args: unknown[]) => mockFetchPatientDetail(...args),
}));

import { PatientQueryRepository } from '../PatientQueryRepository';
import type { AdminPatientsListParams } from '../../interfaces/validators/adminPatientsListSchema';

// ── Helpers ───────────────────────────────────────────────────────────────────

function baseFilters(overrides: Partial<AdminPatientsListParams> = {}): AdminPatientsListParams {
  return {
    limit: 20,
    offset: 0,
    ...overrides,
  } as AdminPatientsListParams;
}

function baseListRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    isTest: false,
    clickupTaskId: 'CU-1',
    firstName: 'Ana',
    lastName: 'García',
    diagnosis: 'ASD',
    dependencyLevel: 'MILD',
    clinicalSpecialty: 'ASD',
    serviceType: ['AT'],
    documentType: 'DNI',
    documentNumber: '1',
    sex: 'FEMALE',
    status: 'ACTIVE',
    needsAttention: false,
    attentionReasons: [],
    addressesCount: '2',
    caseNumber: '766',
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-06-01T00:00:00Z'),
    stageEnteredAt: new Date('2025-01-02T00:00:00Z').toISOString(),
    total_count: '1',
    ...overrides,
  };
}

// ── list() ────────────────────────────────────────────────────────────────────

describe('PatientQueryRepository.list', () => {
  beforeEach(() => mockPoolQuery.mockReset());

  it('a1. monta os params na ordem certa e mapeia rows + total (isTest, addressesCount, caseNumber, SLA)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [baseListRow()] });
    const repo = new PatientQueryRepository();

    const { rows, total } = await repo.list(
      baseFilters({
        search: '  Ana  ',
        needs_attention: 'true',
        attention_reason: 'MISSING_INFO',
        clinical_specialty: 'ASD',
        dependency_level: 'MILD',
        case_number: '766',
        country: 'AR',
        limit: 20,
        offset: 0,
      }),
    );

    expect(total).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'p1',
      isTest: false,
      addressesCount: 2,
      caseNumber: 766,
    });
    expect(rows[0].stageEnteredAt).not.toBeNull();

    const [sql, params] = mockPoolQuery.mock.calls[0];
    expect(sql).toContain('FROM patients p');
    // $1 search (trimmed), $2 needsAttention bool, $3 attentionReason,
    // $4 clinicalSpecialty, $5 dependencyLevel, $6 caseNumber, $7 country,
    // $8 limit, $9 offset.
    expect(params).toEqual(['Ana', true, 'MISSING_INFO', 'ASD', 'MILD', '766', 'AR', 20, 0]);
  });

  it('a2. isTest=true quando a linha marca is_test', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [baseListRow({ isTest: true })] });
    const repo = new PatientQueryRepository();

    const { rows } = await repo.list(baseFilters());
    expect(rows[0].isTest).toBe(true);
  });

  it('a3. needs_attention="false" → filtro boolean false', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const repo = new PatientQueryRepository();

    await repo.list(baseFilters({ needs_attention: 'false' }));
    const [, params] = mockPoolQuery.mock.calls[0];
    expect(params[1]).toBe(false);
  });

  it('a4. needs_attention ausente → filtro null (todos)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const repo = new PatientQueryRepository();

    await repo.list(baseFilters());
    const [, params] = mockPoolQuery.mock.calls[0];
    expect(params[1]).toBeNull();
  });

  it('a5. search vazio/whitespace → null (sem filtro)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const repo = new PatientQueryRepository();

    await repo.list(baseFilters({ search: '   ' }));
    const [, params] = mockPoolQuery.mock.calls[0];
    expect(params[0]).toBeNull();
  });

  it('a6. 0 rows → total=0 (branch: result.rows.length > 0 falso)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const repo = new PatientQueryRepository();

    const { rows, total } = await repo.list(baseFilters());
    expect(total).toBe(0);
    expect(rows).toEqual([]);
  });

  it('a6b. responsibleName com o placeholder pré-D249 sai como null', async () => {
    // As 6 fichas antigas com familiar têm 'Solicitante' em patient_responsibles.
    // "Responsável: Solicitante" seria trocar um card mudo por outro.
    mockPoolQuery.mockResolvedValueOnce({
      rows: [baseListRow({ responsibleName: 'Solicitante' })],
    });

    const repo = new PatientQueryRepository();

    const { rows } = await repo.list(baseFilters({ limit: 20, offset: 0 }));

    expect(rows[0].responsibleName).toBeNull();
  });

  it('a6c. responsibleName real passa; ausente vira null', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [baseListRow({ responsibleName: 'flavia villagra' })],
    });
    const repo = new PatientQueryRepository();
    const comNome = await repo.list(baseFilters({ limit: 20, offset: 0 }));
    expect(comNome.rows[0].responsibleName).toBe('flavia villagra');

    // Coluna ausente na linha (não `null`): o `?? null` do mapeamento.
    mockPoolQuery.mockResolvedValueOnce({ rows: [baseListRow()] });
    const semNome = await repo.list(baseFilters({ limit: 20, offset: 0 }));
    expect(semNome.rows[0].responsibleName).toBeNull();
  });

  it('a7. attentionReasons ausente na linha → [] no mapeamento', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [baseListRow({ attentionReasons: undefined })] });
    const repo = new PatientQueryRepository();

    const { rows } = await repo.list(baseFilters());
    expect(rows[0].attentionReasons).toEqual([]);
  });

  it('a8. caseNumber null na linha → null no mapeamento (sem parseInt)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [baseListRow({ caseNumber: null })] });
    const repo = new PatientQueryRepository();

    const { rows } = await repo.list(baseFilters());
    expect(rows[0].caseNumber).toBeNull();
  });

  it('a9. addressesCount não numérico → 0 (fallback || 0)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [baseListRow({ addressesCount: null })] });
    const repo = new PatientQueryRepository();

    const { rows } = await repo.list(baseFilters());
    expect(rows[0].addressesCount).toBe(0);
  });

  it('a10. stageEnteredAt null → sla.stageEnteredAt null (derivePatientSla com stageEnteredAt=null)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [baseListRow({ stageEnteredAt: null })] });
    const repo = new PatientQueryRepository();

    const { rows } = await repo.list(baseFilters());
    expect(rows[0].stageEnteredAt).toBeNull();
    expect(rows[0].hoursInStage).toBeNull();
  });
});

// ── stats() ───────────────────────────────────────────────────────────────────

describe('PatientQueryRepository.stats', () => {
  beforeEach(() => mockPoolQuery.mockReset());

  function statsRow(overrides: Record<string, unknown> = {}) {
    return {
      total: '10',
      complete: '7',
      needs_attention: '3',
      created_today: '1',
      created_yesterday: '2',
      created_last_7_days: '5',
      ...overrides,
    };
  }

  it('b1. sem country → passa null e coerce todos os campos pra número', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [statsRow()] });
    const repo = new PatientQueryRepository();

    const result = await repo.stats();

    expect(mockPoolQuery.mock.calls[0][1]).toEqual([null]);
    expect(result).toEqual({
      total: 10,
      complete: 7,
      needsAttention: 3,
      createdToday: 1,
      createdYesterday: 2,
      createdLast7Days: 5,
    });
  });

  it('b2. com country=BR → passa "BR" como param', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [statsRow()] });
    const repo = new PatientQueryRepository();

    await repo.stats('BR');
    expect(mockPoolQuery.mock.calls[0][1]).toEqual(['BR']);
  });
});

// ── findDetailById() ─────────────────────────────────────────────────────────

describe('PatientQueryRepository.findDetailById', () => {
  beforeEach(() => {
    mockPoolQuery.mockReset();
    mockFetchPatientDetail.mockReset();
  });

  it('c1. delega para fetchPatientDetail com (pool, encryptionService, id)', async () => {
    const detail = { id: 'p1' } as never;
    mockFetchPatientDetail.mockResolvedValueOnce(detail);
    const repo = new PatientQueryRepository();

    const result = await repo.findDetailById('p1');

    expect(result).toBe(detail);
    expect(mockFetchPatientDetail).toHaveBeenCalledTimes(1);
    const [pool, encSvc, id] = mockFetchPatientDetail.mock.calls[0];
    expect(id).toBe('p1');
    expect(pool).toBeDefined();
    expect(encSvc).toBeDefined();
  });

  it('c2. propaga null quando fetchPatientDetail não encontra o paciente', async () => {
    mockFetchPatientDetail.mockResolvedValueOnce(null);
    const repo = new PatientQueryRepository();

    const result = await repo.findDetailById('missing');
    expect(result).toBeNull();
  });
});
