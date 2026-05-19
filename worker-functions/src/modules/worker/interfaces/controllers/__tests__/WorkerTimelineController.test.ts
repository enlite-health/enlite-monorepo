/**
 * WorkerTimelineController.test.ts
 *
 * Unit tests for WorkerTimelineController.getTimeline.
 *
 * Scenarios:
 * 1. Returns normalised list with correct `kind` per event type
 * 2. Zod rejects `limit` below minimum (0)
 * 3. Zod rejects `limit` above maximum (201)
 * 4. Zod rejects invalid `id` (not a UUID)
 * 5. Returns 500 on db error
 * 6. Returns empty data array when no events exist
 * 7. Total from count query is forwarded in response
 */

import { WorkerTimelineController } from '../WorkerTimelineController';
import { Request, Response } from 'express';

function makeReqRes(
  params: Record<string, string> = {},
  query: Record<string, string> = {},
): [Request, Response] {
  const req = { params, query } as unknown as Request;
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return [req, res];
}

const VALID_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

const STATUS_CHANGE_ROW = {
  kind: 'status_change',
  id: 'ev-1',
  label: 'status',
  old_value: 'AVAILABLE',
  new_value: 'ACTIVE',
  changed_by: 'admin-uid',
  application_id: null,
  template_slug: null,
  occurred_at: '2026-01-01T10:00:00.000Z',
};

const FUNNEL_STAGE_ROW = {
  kind: 'funnel_stage',
  id: 'ev-2',
  label: 'application_funnel_stage',
  old_value: null,
  new_value: 'PRESCREENING',
  changed_by: null,
  application_id: 'app-uuid-1',
  template_slug: null,
  occurred_at: '2026-01-01T09:00:00.000Z',
};

const WHATSAPP_ROW = {
  kind: 'whatsapp',
  id: 'ev-3',
  label: 'complete_register_ofc',
  old_value: null,
  new_value: 'sent',
  changed_by: 'scheduler',
  application_id: null,
  template_slug: 'complete_register_ofc',
  occurred_at: '2026-01-01T08:00:00.000Z',
};

describe('WorkerTimelineController', () => {
  let mockQuery: jest.Mock;
  let mockDb: { query: jest.Mock };
  let controller: WorkerTimelineController;

  beforeEach(() => {
    mockQuery = jest.fn();
    mockDb = { query: mockQuery };
    controller = new WorkerTimelineController(mockDb as never);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getTimeline — happy path', () => {
    it('returns normalised list with correct kind per event type', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [STATUS_CHANGE_ROW, FUNNEL_STAGE_ROW, WHATSAPP_ROW] })
        .mockResolvedValueOnce({ rows: [{ total: '3' }] });

      const [req, res] = makeReqRes({ id: VALID_UUID }, { limit: '10', offset: '0' });
      await controller.getTimeline(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.success).toBe(true);
      expect(body.total).toBe(3);
      expect(body.data).toHaveLength(3);

      const [sc, fs, wa] = body.data;
      expect(sc.kind).toBe('status_change');
      expect(sc.old_value).toBe('AVAILABLE');
      expect(sc.application_id).toBeNull();

      expect(fs.kind).toBe('funnel_stage');
      expect(fs.old_value).toBeNull();
      expect(fs.application_id).toBe('app-uuid-1');

      expect(wa.kind).toBe('whatsapp');
      expect(wa.template_slug).toBe('complete_register_ofc');
    });

    it('returns empty data array when no events exist', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ total: '0' }] });

      const [req, res] = makeReqRes({ id: VALID_UUID });
      await controller.getTimeline(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.data).toHaveLength(0);
      expect(body.total).toBe(0);
    });

    it('forwards limit and offset defaults in response', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ total: '0' }] });

      const [req, res] = makeReqRes({ id: VALID_UUID }); // no limit/offset
      await controller.getTimeline(req, res);

      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.limit).toBe(50);
      expect(body.offset).toBe(0);
    });

    it('forwards total from count query', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [STATUS_CHANGE_ROW] })
        .mockResolvedValueOnce({ rows: [{ total: '42' }] });

      const [req, res] = makeReqRes({ id: VALID_UUID }, { limit: '1', offset: '0' });
      await controller.getTimeline(req, res);

      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.total).toBe(42);
    });
  });

  describe('getTimeline — Zod validation', () => {
    it('rejects invalid id (not a UUID)', async () => {
      const [req, res] = makeReqRes({ id: 'not-a-uuid' });
      await controller.getTimeline(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/invalid/i);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('rejects limit below minimum (0)', async () => {
      const [req, res] = makeReqRes({ id: VALID_UUID }, { limit: '0' });
      await controller.getTimeline(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.success).toBe(false);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('rejects limit above maximum (201)', async () => {
      const [req, res] = makeReqRes({ id: VALID_UUID }, { limit: '201' });
      await controller.getTimeline(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.success).toBe(false);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('rejects negative offset', async () => {
      const [req, res] = makeReqRes({ id: VALID_UUID }, { offset: '-1' });
      await controller.getTimeline(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe('getTimeline — error handling', () => {
    it('returns 500 on db error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('connection refused'));

      const [req, res] = makeReqRes({ id: VALID_UUID });
      await controller.getTimeline(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.success).toBe(false);
      expect(body.error).toContain('connection refused');
    });
  });
});
