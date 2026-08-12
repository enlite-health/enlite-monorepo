/**
 * RecruitmentBlockedController — Unit Tests (branches não cobertos pelo co-located)
 *
 * Cobre branches específicos não presentes em
 * src/modules/matching/interfaces/controllers/__tests__/RecruitmentBlockedController.test.ts:
 *
 *   - err instanceof Error ternário: branch `''` (erro não-Error) → 500
 *   - page=0, limit=0, limit=200 → 400 via parsePaginationOptions
 *   - hasNext calculado corretamente (offset + data.length < total)
 *   - totalPages arredondado para cima
 *   - filtros combinados (jobPostingId + workerId + reason)
 *   - lista vazia (data=[], total=0, hasNext=false, hasPrev=false)
 *   - hasPrev=true quando page >= 2
 */

// ── Mocks (hoist antes dos imports) ──────────────────────────────────

const mockList = jest.fn();
const mockAggregates = jest.fn();

jest.mock(
  '../../../src/modules/matching/infrastructure/BlockedApplicationQueryRepository',
  () => ({
    BlockedApplicationQueryRepository: jest.fn().mockImplementation(() => ({
      list: mockList,
      aggregates: mockAggregates,
    })),
  }),
);

const mockLoggerWarn = jest.fn();
jest.mock('@shared/logging', () => ({
  logger: {
    warn: mockLoggerWarn,
    child: jest.fn().mockReturnValue({ warn: mockLoggerWarn, info: jest.fn() }),
    info: jest.fn(),
    error: jest.fn(),
  },
  reportError: jest.fn(),
}));

import { RecruitmentBlockedController } from '../../../src/modules/matching/interfaces/controllers/RecruitmentBlockedController';

// ── Helpers ──────────────────────────────────────────────────────────

function mockReq(query: Record<string, string> = {}): unknown {
  return { query };
}

function mockRes(): { status: jest.Mock; json: jest.Mock } {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

const VACANCY_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const WORKER_ID  = 'bbbbbbbb-0000-0000-0000-000000000002';

const SAMPLE_ROW = {
  id: 'cccccccc-0000-0000-0000-000000000003',
  workerId: WORKER_ID,
  jobPostingId: VACANCY_ID,
  blockedReason: 'registration_incomplete',
  missingFields: ['phone'],
  attemptCount: 1,
  firstAttemptedAt: '2026-01-01T00:00:00.000Z',
  lastAttemptedAt: '2026-01-02T00:00:00.000Z',
  acquisitionChannel: 'facebook',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

const SAMPLE_AGGREGATES = {
  totalBlocked: 2,
  byReason: { registration_incomplete: 1, worker_disabled: 1 },
};

function setupDefaultMocks(
  overrides: {
    data?: typeof SAMPLE_ROW[];
    total?: number;
    aggregates?: typeof SAMPLE_AGGREGATES;
  } = {},
): void {
  mockList.mockResolvedValueOnce({
    data: overrides.data ?? [SAMPLE_ROW],
    total: overrides.total ?? 1,
  });
  mockAggregates.mockResolvedValueOnce(
    overrides.aggregates ?? SAMPLE_AGGREGATES,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('RecruitmentBlockedController — branches e caminhos adicionais', () => {
  let controller: RecruitmentBlockedController;

  beforeEach(() => {
    mockList.mockReset();
    mockAggregates.mockReset();
    mockLoggerWarn.mockReset();
    controller = new RecruitmentBlockedController();
  });

  // ── Caminho feliz ─────────────────────────────────────────────────

  it('200 com shape completo: data + aggregates + pagination', async () => {
    setupDefaultMocks();
    const req = mockReq();
    const res = mockRes();

    await controller.listBlockedAttempts(req as never, res as never);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: [SAMPLE_ROW],
        aggregates: SAMPLE_AGGREGATES,
        pagination: expect.objectContaining({ total: 1, limit: 50, offset: 0, page: 1 }),
      }),
    );
  });

  // ── Validação params inválidos ────────────────────────────────────

  it('jobPostingId inválido (não UUID) → 400', async () => {
    const res = mockRes();
    await controller.listBlockedAttempts(mockReq({ jobPostingId: 'not-a-uuid' }) as never, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('workerId inválido (não UUID) → 400', async () => {
    const res = mockRes();
    await controller.listBlockedAttempts(mockReq({ workerId: 'bad' }) as never, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('reason inválido → 400 com erro Zod', async () => {
    const res = mockRes();
    await controller.listBlockedAttempts(mockReq({ reason: 'INVALID_REASON' }) as never, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: expect.any(String) }),
    );
    expect(mockList).not.toHaveBeenCalled();
  });

  // ── Paginação: branches de parsePaginationOptions ─────────────────

  it('page=0 → 400 via parsePaginationOptions', async () => {
    const res = mockRes();
    await controller.listBlockedAttempts(mockReq({ page: '0' }) as never, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('limit=200 → 400 via parsePaginationOptions', async () => {
    const res = mockRes();
    await controller.listBlockedAttempts(mockReq({ limit: '200' }) as never, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('limit=0 → 400 via parsePaginationOptions', async () => {
    const res = mockRes();
    await controller.listBlockedAttempts(mockReq({ limit: '0' }) as never, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  // ── Paginação: cálculo correto ────────────────────────────────────

  it('page=2 + limit=10 → offset=10, hasPrev=true', async () => {
    setupDefaultMocks({ total: 25 });
    const req = mockReq({ page: '2', limit: '10' });
    const res = mockRes();

    await controller.listBlockedAttempts(req as never, res as never);

    expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ limit: 10, offset: 10 }));
    const json = (res.json.mock.calls[0] as [Record<string, unknown>])[0];
    expect(json.pagination).toMatchObject({ page: 2, offset: 10, hasPrev: true, total: 25 });
  });

  it('hasNext=true quando offset+data.length < total', async () => {
    setupDefaultMocks({ data: Array(5).fill(SAMPLE_ROW) as typeof SAMPLE_ROW[], total: 10 });
    const res = mockRes();
    await controller.listBlockedAttempts(mockReq({ page: '1', limit: '5' }) as never, res as never);
    const json = (res.json.mock.calls[0] as [Record<string, unknown>])[0];
    expect((json.pagination as Record<string, unknown>).hasNext).toBe(true);
  });

  it('totalPages = ceil(total/limit)', async () => {
    setupDefaultMocks({ total: 11 });
    const res = mockRes();
    await controller.listBlockedAttempts(mockReq({ limit: '5' }) as never, res as never);
    const json = (res.json.mock.calls[0] as [Record<string, unknown>])[0];
    expect((json.pagination as Record<string, unknown>).totalPages).toBe(3);
  });

  // ── Filtros ───────────────────────────────────────────────────────

  it('reason=worker_not_found → passa para repo.list', async () => {
    setupDefaultMocks();
    const res = mockRes();
    await controller.listBlockedAttempts(mockReq({ reason: 'worker_not_found' }) as never, res as never);
    expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ reason: 'worker_not_found' }));
  });

  it('reason=worker_disabled → passa para repo.list', async () => {
    setupDefaultMocks();
    const res = mockRes();
    await controller.listBlockedAttempts(mockReq({ reason: 'worker_disabled' }) as never, res as never);
    expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ reason: 'worker_disabled' }));
  });

  it('filtros combinados: jobPostingId + workerId + reason', async () => {
    setupDefaultMocks();
    const req = mockReq({ jobPostingId: VACANCY_ID, workerId: WORKER_ID, reason: 'worker_disabled' });
    const res = mockRes();

    await controller.listBlockedAttempts(req as never, res as never);

    expect(mockList).toHaveBeenCalledWith(
      expect.objectContaining({ jobPostingId: VACANCY_ID, workerId: WORKER_ID, reason: 'worker_disabled' }),
    );
  });

  // ── Erro genérico → 500 ───────────────────────────────────────────

  it('500 quando repo lança erro genérico', async () => {
    mockList.mockRejectedValueOnce(new Error('DB timeout'));
    mockAggregates.mockRejectedValueOnce(new Error('DB timeout'));
    const res = mockRes();

    await controller.listBlockedAttempts(mockReq() as never, res as never);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: 'Failed to fetch blocked attempts' }),
    );
  });

  it('loga warn quando repo lança', async () => {
    mockList.mockRejectedValueOnce(new Error('exploded'));
    mockAggregates.mockRejectedValueOnce(new Error('exploded'));
    const res = mockRes();
    await controller.listBlockedAttempts(mockReq() as never, res as never);
    expect(mockLoggerWarn).toHaveBeenCalled();
  });

  it('erro com "page" na mensagem → 400', async () => {
    mockList.mockRejectedValueOnce(new Error('Page must be greater than 0'));
    mockAggregates.mockRejectedValueOnce(new Error('Page must be greater than 0'));
    const res = mockRes();
    await controller.listBlockedAttempts(mockReq() as never, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('erro com "limit" na mensagem → 400', async () => {
    mockList.mockRejectedValueOnce(new Error('Limit must be between 1 and 100'));
    mockAggregates.mockRejectedValueOnce(new Error('Limit must be between 1 and 100'));
    const res = mockRes();
    await controller.listBlockedAttempts(mockReq() as never, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('erro não-Error lançado → 500 (cobre branch ternário não-Error)', async () => {
    mockList.mockRejectedValueOnce('raw string error');
    mockAggregates.mockRejectedValueOnce('raw string error');
    const res = mockRes();
    await controller.listBlockedAttempts(mockReq() as never, res as never);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  // ── Lista vazia ───────────────────────────────────────────────────

  it('200 com data=[] e total=0', async () => {
    setupDefaultMocks({ data: [], total: 0 });
    const res = mockRes();
    await controller.listBlockedAttempts(mockReq() as never, res as never);
    expect(res.status).toHaveBeenCalledWith(200);
    const json = (res.json.mock.calls[0] as [Record<string, unknown>])[0];
    expect(json.data).toEqual([]);
    expect((json.pagination as Record<string, unknown>).hasNext).toBe(false);
    expect((json.pagination as Record<string, unknown>).hasPrev).toBe(false);
  });
});
