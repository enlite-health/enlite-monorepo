/**
 * RecruitmentBlockedController.test.ts
 *
 * Cenários:
 * 1. Sucesso sem filtros — retorna data + aggregates + pagination
 * 2. Filtros UUID válidos — repassa para repo.list
 * 3. reason inválido — 400
 * 4. jobPostingId com UUID inválido — 400
 * 5. Paginação inválida (limit=0) — 400
 * 6. Erro interno do repo — 500
 * 7. workerId filtro — repassa corretamente
 */

const mockList = jest.fn();
const mockAggregates = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({ query: jest.fn() }),
    }),
  },
}));

jest.mock('@modules/matching/infrastructure/BlockedApplicationQueryRepository', () => ({
  BlockedApplicationQueryRepository: jest.fn().mockImplementation(() => ({
    list: mockList,
    aggregates: mockAggregates,
  })),
}));

jest.mock('@shared/logging', () => ({
  logger: {
    child: jest.fn().mockReturnValue({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  },
}));

import { RecruitmentBlockedController } from '../RecruitmentBlockedController';
import { Request, Response } from 'express';

const VALID_UUID = 'aaaabbbb-0000-0000-0000-111111111111';
const JOB_UUID   = 'ccccdddd-0000-0000-0000-222222222222';

const DEFAULT_AGGREGATES = {
  totalBlocked: 3,
  byReason: { registration_incomplete: 2, worker_disabled: 1 },
};

const SAMPLE_ROW = {
  id: VALID_UUID,
  workerId: VALID_UUID,
  jobPostingId: JOB_UUID,
  blockedReason: 'registration_incomplete',
  missingFields: ['phone'],
  attemptCount: 1,
  firstAttemptedAt: '2026-01-01T00:00:00.000Z',
  lastAttemptedAt: '2026-01-01T00:00:00.000Z',
  acquisitionChannel: 'facebook',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function makeReqRes(
  query: Record<string, string> = {},
): [Request, Response] {
  const req = { query } as unknown as Request;
  const res = {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return [req, res];
}

describe('RecruitmentBlockedController — listBlockedAttempts', () => {
  let controller: RecruitmentBlockedController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new RecruitmentBlockedController();
  });

  it('retorna 200 com data + aggregates + pagination sem filtros', async () => {
    mockList.mockResolvedValueOnce({ data: [SAMPLE_ROW], total: 1 });
    mockAggregates.mockResolvedValueOnce(DEFAULT_AGGREGATES);

    const [req, res] = makeReqRes();
    await controller.listBlockedAttempts(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.aggregates).toEqual(DEFAULT_AGGREGATES);
    expect(body.pagination).toMatchObject({
      total: 1,
      page: 1,
    });
  });

  it('passa jobPostingId e workerId como filtros para repo.list', async () => {
    mockList.mockResolvedValueOnce({ data: [], total: 0 });
    mockAggregates.mockResolvedValueOnce({ totalBlocked: 0, byReason: {} });

    const [req, res] = makeReqRes({ jobPostingId: JOB_UUID, workerId: VALID_UUID });
    await controller.listBlockedAttempts(req, res);

    expect(mockList).toHaveBeenCalledWith(
      expect.objectContaining({ jobPostingId: JOB_UUID, workerId: VALID_UUID }),
    );
  });

  it('passa reason como filtro para repo.list', async () => {
    mockList.mockResolvedValueOnce({ data: [], total: 0 });
    mockAggregates.mockResolvedValueOnce({ totalBlocked: 0, byReason: {} });

    const [req, res] = makeReqRes({ reason: 'worker_disabled' });
    await controller.listBlockedAttempts(req, res);

    expect(mockList).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'worker_disabled' }),
    );
  });

  it('retorna 400 para reason inválido', async () => {
    const [req, res] = makeReqRes({ reason: 'unknown_reason' });
    await controller.listBlockedAttempts(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('retorna 400 para jobPostingId com formato não-UUID', async () => {
    const [req, res] = makeReqRes({ jobPostingId: 'not-a-uuid' });
    await controller.listBlockedAttempts(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('retorna 400 para limit=0 (paginação inválida)', async () => {
    const [req, res] = makeReqRes({ limit: '0' });
    await controller.listBlockedAttempts(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('retorna 500 quando repo.list falha', async () => {
    mockList.mockRejectedValueOnce(new Error('DB timeout'));
    mockAggregates.mockResolvedValueOnce(DEFAULT_AGGREGATES);

    const [req, res] = makeReqRes();
    await controller.listBlockedAttempts(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.success).toBe(false);
    expect(body.error).toBe('Failed to fetch blocked attempts');
  });

  it('retorna 500 quando repo.aggregates falha', async () => {
    mockList.mockResolvedValueOnce({ data: [], total: 0 });
    mockAggregates.mockRejectedValueOnce(new Error('Aggregates DB error'));

    const [req, res] = makeReqRes();
    await controller.listBlockedAttempts(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('resposta 200 contém totalPages calculado corretamente', async () => {
    mockList.mockResolvedValueOnce({ data: new Array(10).fill(SAMPLE_ROW), total: 35 });
    mockAggregates.mockResolvedValueOnce(DEFAULT_AGGREGATES);

    const [req, res] = makeReqRes({ limit: '10', page: '2' });
    await controller.listBlockedAttempts(req, res);

    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.pagination.totalPages).toBe(4); // ceil(35/10)
    expect(body.pagination.hasNext).toBe(true);
    expect(body.pagination.hasPrev).toBe(true);
  });
});
