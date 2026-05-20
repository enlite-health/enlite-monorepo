import { Request, Response } from 'express';
import { Pool, QueryResult } from 'pg';
import { RecruitmentHealthController } from '../RecruitmentHealthController';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyQueryResult = QueryResult<any>;

jest.mock('@shared/logging', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    child: jest.fn().mockReturnValue({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }),
  },
  reportError: jest.fn(),
}));

function mockRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
}

function mockReq(): Request {
  return {} as unknown as Request;
}

/** Builds a pg QueryResult for the auto-invite scalar query. */
function autoInviteRow(overrides: Partial<{
  vacancies_created: string;
  invites_enqueued: string;
  invites_sent: string;
  invites_delivered: string;
  invites_failed: string;
}> = {}): QueryResult {
  const row = {
    vacancies_created: '3',
    invites_enqueued: '10',
    invites_sent: '8',
    invites_delivered: '6',
    invites_failed: '2',
    ...overrides,
  };
  return { rows: [row], rowCount: 1 } as unknown as QueryResult;
}

/** Builds a pg QueryResult for the last-batch aggregate query. */
function batchRow(overrides: Partial<{
  batch_id: string;
  total: string;
  sent: string;
  errors: string;
  started_at: string;
  finished_at: string;
}> = {}): QueryResult {
  const row = {
    batch_id: 'aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee',
    total: '20',
    sent: '18',
    errors: '2',
    started_at: '2026-05-19T10:00:00+00:00',
    finished_at: '2026-05-19T10:05:00+00:00',
    ...overrides,
  };
  return { rows: [row], rowCount: 1 } as unknown as QueryResult;
}

/** Empty pg QueryResult — simulates no batch found. */
function emptyResult(): QueryResult {
  return { rows: [], rowCount: 0 } as unknown as QueryResult;
}

describe('RecruitmentHealthController', () => {
  let db: { query: jest.MockedFunction<(...args: unknown[]) => Promise<AnyQueryResult>> } & Pick<Pool, never>;
  let controller: RecruitmentHealthController;

  beforeEach(() => {
    db = { query: jest.fn() } as unknown as typeof db;
    controller = new RecruitmentHealthController(db as unknown as Pool);
  });

  // ─── getHealth — happy path ──────────────────────────────────────────

  describe('getHealth — success', () => {
    beforeEach(() => {
      db.query
        .mockResolvedValueOnce(autoInviteRow())   // queryAutoInvite24h
        .mockResolvedValueOnce(batchRow())         // queryLastBatch('complete_register_ofc')
        .mockResolvedValueOnce(batchRow({          // queryLastBatch('talentum_incomplete_reminder')
          batch_id: 'ffffffff-1111-4222-8333-444444444444',
          total: '5',
          sent: '4',
          errors: '1',
        }));
    });

    it('responds 200 with success: true', async () => {
      const res = mockRes();
      await controller.getHealth(mockReq(), res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect((res.json as jest.Mock).mock.calls[0][0].success).toBe(true);
    });

    it('auto_invite_last_24h fields are numbers', async () => {
      const res = mockRes();
      await controller.getHealth(mockReq(), res);
      const { auto_invite_last_24h } = (res.json as jest.Mock).mock.calls[0][0].data;
      expect(typeof auto_invite_last_24h.vacancies_created).toBe('number');
      expect(typeof auto_invite_last_24h.invites_enqueued).toBe('number');
      expect(typeof auto_invite_last_24h.invites_sent).toBe('number');
      expect(typeof auto_invite_last_24h.invites_delivered).toBe('number');
      expect(typeof auto_invite_last_24h.invites_failed).toBe('number');
    });

    it('auto_invite_last_24h values match the DB row', async () => {
      const res = mockRes();
      await controller.getHealth(mockReq(), res);
      const { auto_invite_last_24h } = (res.json as jest.Mock).mock.calls[0][0].data;
      expect(auto_invite_last_24h).toEqual({
        vacancies_created: 3,
        invites_enqueued: 10,
        invites_sent: 8,
        invites_delivered: 6,
        invites_failed: 2,
      });
    });

    it('bulk_dispatch_incomplete_last_run fields are numbers or strings', async () => {
      const res = mockRes();
      await controller.getHealth(mockReq(), res);
      const { bulk_dispatch_incomplete_last_run } = (res.json as jest.Mock).mock.calls[0][0].data;
      expect(typeof bulk_dispatch_incomplete_last_run.batch_id).toBe('string');
      expect(typeof bulk_dispatch_incomplete_last_run.total).toBe('number');
      expect(typeof bulk_dispatch_incomplete_last_run.sent).toBe('number');
      expect(typeof bulk_dispatch_incomplete_last_run.errors).toBe('number');
    });

    it('bulk_dispatch_talentum_last_run batch_id differs from incomplete run', async () => {
      const res = mockRes();
      await controller.getHealth(mockReq(), res);
      const { bulk_dispatch_talentum_last_run } = (res.json as jest.Mock).mock.calls[0][0].data;
      expect(bulk_dispatch_talentum_last_run.batch_id).toBe('ffffffff-1111-4222-8333-444444444444');
      expect(bulk_dispatch_talentum_last_run.total).toBe(5);
    });

    it('issues exactly 3 DB queries in parallel', async () => {
      const res = mockRes();
      await controller.getHealth(mockReq(), res);
      expect(db.query).toHaveBeenCalledTimes(3);
    });
  });

  // ─── queryLastBatch — no rows (never ran) ────────────────────────────

  describe('getHealth — batch never ran', () => {
    beforeEach(() => {
      db.query
        .mockResolvedValueOnce(autoInviteRow())
        .mockResolvedValueOnce(emptyResult())   // no incomplete batch
        .mockResolvedValueOnce(emptyResult());  // no talentum batch
    });

    it('returns batch_id: null when no batch exists', async () => {
      const res = mockRes();
      await controller.getHealth(mockReq(), res);
      const { bulk_dispatch_incomplete_last_run, bulk_dispatch_talentum_last_run } =
        (res.json as jest.Mock).mock.calls[0][0].data;
      expect(bulk_dispatch_incomplete_last_run.batch_id).toBeNull();
      expect(bulk_dispatch_talentum_last_run.batch_id).toBeNull();
    });

    it('returns zero counts when no batch exists', async () => {
      const res = mockRes();
      await controller.getHealth(mockReq(), res);
      const { bulk_dispatch_incomplete_last_run } = (res.json as jest.Mock).mock.calls[0][0].data;
      expect(bulk_dispatch_incomplete_last_run.total).toBe(0);
      expect(bulk_dispatch_incomplete_last_run.sent).toBe(0);
      expect(bulk_dispatch_incomplete_last_run.errors).toBe(0);
      expect(bulk_dispatch_incomplete_last_run.started_at).toBeNull();
      expect(bulk_dispatch_incomplete_last_run.finished_at).toBeNull();
    });

    it('still responds 200', async () => {
      const res = mockRes();
      await controller.getHealth(mockReq(), res);
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  // ─── getHealth — DB error ────────────────────────────────────────────

  describe('getHealth — DB failure', () => {
    it('responds 500 with success: false', async () => {
      db.query.mockRejectedValue(new Error('connection lost'));
      const res = mockRes();
      await controller.getHealth(mockReq(), res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect((res.json as jest.Mock).mock.calls[0][0].success).toBe(false);
    });

    it('includes error message in response body', async () => {
      db.query.mockRejectedValue(new Error('relation "domain_events" does not exist'));
      const res = mockRes();
      await controller.getHealth(mockReq(), res);
      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.error).toContain('domain_events');
    });

    it('wraps non-Error throws', async () => {
      db.query.mockRejectedValue('string rejection');
      const res = mockRes();
      await controller.getHealth(mockReq(), res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect((res.json as jest.Mock).mock.calls[0][0].success).toBe(false);
    });
  });
});
