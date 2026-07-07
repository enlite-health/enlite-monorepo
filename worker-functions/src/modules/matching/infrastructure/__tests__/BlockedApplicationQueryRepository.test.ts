/**
 * BlockedApplicationQueryRepository.test.ts
 *
 * Testes unitários (mock de pool) para cobertura de branches defensivos
 * que não podem ser exercitados com banco real:
 *
 *   1. list() — missingFields = [] quando missing_fields não é array (branch ternário)
 *   2. list() — total = 0 quando countResult.rows[0] é undefined (branch ?? 0)
 *   3. aggregates() — byReason e totalBlocked corretos para múltiplas linhas
 *   4. list() — acquisitionChannel null (branch ?? null)
 *   5. listByVacancy() — retorna BlockedAttemptForFunnelDto corretamente (migration 230)
 *   6. listByVacancy() — missingFields=[] branch defensivo
 *   7. listByVacancy() — workerId null (worker_not_found)
 *
 * Nota: testes com banco real ficam em
 *   tests/e2e/blocked-application-repositories.integration.test.ts
 */

const mockQuery = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({ query: mockQuery }),
    }),
  },
}));

import { BlockedApplicationQueryRepository } from '../BlockedApplicationQueryRepository';

const WORKER_ID   = 'aaaaaaaa-0000-0000-0000-111111111111';
const JOB_ID      = 'bbbbbbbb-0000-0000-0000-222222222222';
const ENTRY_ID    = 'cccccccc-0000-0000-0000-333333333333';
const NOW_DATE    = new Date('2026-01-01T00:00:00.000Z');

function makeRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: ENTRY_ID,
    worker_id: WORKER_ID,
    job_posting_id: JOB_ID,
    blocked_reason: 'registration_incomplete',
    missing_fields: ['phone'],  // array (happy path)
    attempt_count: 1,
    first_attempted_at: NOW_DATE,
    last_attempted_at: NOW_DATE,
    acquisition_channel: 'facebook',
    created_at: NOW_DATE,
    updated_at: NOW_DATE,
    ...overrides,
  };
}

describe('BlockedApplicationQueryRepository', () => {
  let repo: BlockedApplicationQueryRepository;

  beforeEach(() => {
    mockQuery.mockReset();
    repo = new BlockedApplicationQueryRepository();
  });

  // ── list() — caminho feliz ───────────────────────────────────────

  it('lista retorna DTO mapeado corretamente (caminho feliz)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeRow()] });         // data
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 1 }] });     // count

    const result = await repo.list({ limit: 10, offset: 0 });

    expect(result.data).toHaveLength(1);
    const item = result.data[0];
    expect(item.id).toBe(ENTRY_ID);
    expect(item.workerId).toBe(WORKER_ID);
    expect(item.jobPostingId).toBe(JOB_ID);
    expect(item.blockedReason).toBe('registration_incomplete');
    expect(item.missingFields).toEqual(['phone']);
    expect(item.attemptCount).toBe(1);
    expect(item.firstAttemptedAt).toBe(NOW_DATE.toISOString());
    expect(item.lastAttemptedAt).toBe(NOW_DATE.toISOString());
    expect(item.acquisitionChannel).toBe('facebook');
    expect(result.total).toBe(1);
  });

  it('missingFields = [] quando missing_fields não é array (branch defensivo)', async () => {
    // Cobre linha 108: `Array.isArray(r.missing_fields) ? r.missing_fields : []`
    // Branch falso: missing_fields retorna como string (caso hipotético)
    mockQuery.mockResolvedValueOnce({ rows: [makeRow({ missing_fields: 'not-an-array' })] });
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 1 }] });

    const result = await repo.list({ limit: 10, offset: 0 });

    expect(result.data[0].missingFields).toEqual([]);
  });

  it('total = 0 quando countResult.rows[0] é undefined (branch ?? 0)', async () => {
    // Cobre linha 119: `(countResult.rows[0]?.total as number) ?? 0`
    mockQuery.mockResolvedValueOnce({ rows: [] });    // data vazia
    mockQuery.mockResolvedValueOnce({ rows: [] });    // count: rows vazio → undefined

    const result = await repo.list({ limit: 10, offset: 0 });

    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('acquisitionChannel = null quando null no banco (branch ?? null)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeRow({ acquisition_channel: null })] });
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 1 }] });

    const result = await repo.list({ limit: 10, offset: 0 });

    expect(result.data[0].acquisitionChannel).toBeNull();
  });

  it('filtros jobPostingId/workerId/reason constroem WHERE correto', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await repo.list({
      jobPostingId: JOB_ID,
      workerId: WORKER_ID,
      reason: 'worker_disabled',
      limit: 10,
      offset: 0,
    });

    const dataQueryCall = mockQuery.mock.calls[0][0] as string;
    expect(dataQueryCall).toContain('wba.job_posting_id = $1');
    expect(dataQueryCall).toContain('wba.worker_id = $2');
    expect(dataQueryCall).toContain('wba.blocked_reason = $3');
    expect(dataQueryCall).toContain('WHERE');
  });

  it('sem filtros: WHERE clause ausente e LIMIT/OFFSET usam índices $1/$2', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await repo.list({ limit: 50, offset: 0 });

    const dataQueryCall = mockQuery.mock.calls[0][0] as string;
    expect(dataQueryCall).not.toContain('WHERE');
    expect(dataQueryCall).toContain('LIMIT $1 OFFSET $2');
  });

  // ── aggregates() ─────────────────────────────────────────────────

  it('aggregates() com múltiplas reasons', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { blocked_reason: 'registration_incomplete', count: 5 },
        { blocked_reason: 'worker_disabled', count: 2 },
        { blocked_reason: 'worker_not_found', count: 1 },
      ],
    });

    const agg = await repo.aggregates();

    expect(agg.totalBlocked).toBe(8);
    expect(agg.byReason).toEqual({
      registration_incomplete: 5,
      worker_disabled: 2,
      worker_not_found: 1,
    });
  });

  it('aggregates() com tabela vazia → totalBlocked=0 e byReason={}', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const agg = await repo.aggregates();

    expect(agg.totalBlocked).toBe(0);
    expect(agg.byReason).toEqual({});
  });

  // ── listByVacancy() — migration 230 ──────────────────────────────
  // Usado pelo WJAFunnelController para montar a coluna INICIADO do kanban.

  it('listByVacancy() retorna BlockedAttemptForFunnelDto mapeado corretamente', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'ba-1',
        worker_id: WORKER_ID,
        blocked_reason: 'registration_incomplete',
        missing_fields: ['profession', 'phone'],
        attempt_count: 3,
        acquisition_channel: 'facebook',
        last_attempted_at: NOW_DATE,
        contact_notes_count: 2,
      }],
    });

    const result = await repo.listByVacancy(JOB_ID);

    expect(result).toHaveLength(1);
    const item = result[0];
    expect(item.id).toBe('ba-1');
    expect(item.workerId).toBe(WORKER_ID);
    expect(item.blockedReason).toBe('registration_incomplete');
    expect(item.missingFields).toEqual(['profession', 'phone']);
    expect(item.attemptCount).toBe(3);
    expect(item.acquisitionChannel).toBe('facebook');
    expect(item.lastAttemptedAt).toBe(NOW_DATE.toISOString());
    expect(item.contactNotesCount).toBe(2);
  });

  it('listByVacancy() — contactNotesCount default 0 quando ausente/undefined (branch defensivo)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'ba-1b',
        worker_id: WORKER_ID,
        blocked_reason: 'registration_incomplete',
        missing_fields: [],
        attempt_count: 1,
        acquisition_channel: null,
        last_attempted_at: NOW_DATE,
        // contact_notes_count ausente
      }],
    });

    const result = await repo.listByVacancy(JOB_ID);
    expect(result[0].contactNotesCount).toBe(0);
  });

  it('listByVacancy() — SQL soma contact_notes_count filtrando só pela VAGA (job_posting_id) — migration 236', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await repo.listByVacancy(JOB_ID);

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('wja_contact_notes cn');
    expect(sql).toContain('cn.job_posting_id = $1');
    expect(sql).not.toContain('cn.worker_id');
    expect(sql).toContain('contact_notes_count');
  });

  it('listByVacancy() inclui NOT EXISTS para dedup (query SQL deve ter NOT EXISTS)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await repo.listByVacancy(JOB_ID);

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('worker_job_applications');
    expect(sql).toContain('wja.worker_id  = wba.worker_id');
    expect(sql).toContain('wja.job_posting_id = wba.job_posting_id');
  });

  it('listByVacancy() — missingFields = [] quando missing_fields não é array (branch defensivo)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'ba-2',
        worker_id: WORKER_ID,
        blocked_reason: 'registration_incomplete',
        missing_fields: null, // não é array
        attempt_count: 1,
        acquisition_channel: null,
        last_attempted_at: NOW_DATE,
      }],
    });

    const result = await repo.listByVacancy(JOB_ID);
    expect(result[0].missingFields).toEqual([]);
  });

  it('listByVacancy() — workerId = null quando worker_not_found', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'ba-3',
        worker_id: null, // worker_not_found
        blocked_reason: 'worker_not_found',
        missing_fields: [],
        attempt_count: 1,
        acquisition_channel: null,
        last_attempted_at: NOW_DATE,
      }],
    });

    const result = await repo.listByVacancy(JOB_ID);
    expect(result[0].workerId).toBeNull();
  });

  it('listByVacancy() — retorna lista vazia quando não há bloqueados', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await repo.listByVacancy(JOB_ID);
    expect(result).toHaveLength(0);
  });
});
