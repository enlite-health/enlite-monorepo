import { Request, Response } from 'express';
import { InternalController } from '../InternalController';
import { DomainEventProcessor } from '@shared/events/DomainEventProcessor';
import { DomainEventBacklogService } from '@shared/events/DomainEventBacklogService';
import { OutboxProcessor } from '../../../infrastructure/OutboxProcessor';
import { ReminderScheduler } from '../../../infrastructure/ReminderScheduler';
import { BulkDispatchScheduler } from '../../../infrastructure/BulkDispatchScheduler';
import { BulkDispatchTalentumScheduler } from '../../../infrastructure/BulkDispatchTalentumScheduler';

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

function mockReq(body: Record<string, unknown> = {}, query: Record<string, unknown> = {}): Request {
  return { body, query } as unknown as Request;
}

/** Helper: build a Pub/Sub push body with base64-encoded data */
function pubsubBody(data: Record<string, unknown>) {
  return {
    message: {
      data: Buffer.from(JSON.stringify(data)).toString('base64'),
      messageId: 'msg-1',
    },
    subscription: 'sub-1',
  };
}

describe('InternalController', () => {
  let eventProcessor: jest.Mocked<DomainEventProcessor>;
  let outboxProcessor: jest.Mocked<OutboxProcessor>;
  let reminderScheduler: jest.Mocked<ReminderScheduler>;
  let bulkDispatchScheduler: jest.Mocked<BulkDispatchScheduler>;
  let bulkDispatchTalentumScheduler: jest.Mocked<BulkDispatchTalentumScheduler>;
  let domainEventBacklogService: jest.Mocked<DomainEventBacklogService>;
  let controller: InternalController;

  beforeEach(() => {
    eventProcessor = {
      processEvent: jest.fn().mockResolvedValue({ status: 'processed', event: 'test' }),
      sweepPendingEvents: jest.fn().mockResolvedValue(3),
      sweepPendingByEvent: jest.fn().mockResolvedValue({ processed: 2, total: 3 }),
      deleteRedundantMirrorEvents: jest.fn().mockResolvedValue(1),
      registerHandler: jest.fn(),
      getHandledEvents: jest.fn().mockReturnValue(['worker.registration_completed', 'vacancy.created']),
    } as unknown as jest.Mocked<DomainEventProcessor>;

    outboxProcessor = {
      processById: jest.fn().mockResolvedValue(undefined),
      processBatch: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<OutboxProcessor>;

    reminderScheduler = {
      processQualifiedReminder: jest.fn().mockResolvedValue(undefined),
      process5MinReminder: jest.fn().mockResolvedValue(undefined),
      scheduleReminders: jest.fn().mockResolvedValue({ taskNames: [] }),
      cancelReminders: jest.fn().mockResolvedValue(undefined),
      processBatch: jest.fn().mockResolvedValue({ dayCount: 0, minCount: 0, noShows: 0 }),
    } as unknown as jest.Mocked<ReminderScheduler>;

    bulkDispatchScheduler = {
      run: jest.fn().mockResolvedValue({ total: 10, sent: 8, errors: 2 }),
    } as unknown as jest.Mocked<BulkDispatchScheduler>;

    bulkDispatchTalentumScheduler = {
      run: jest.fn().mockResolvedValue({ batchId: 'batch-t-1', total: 5, sent: 4, errors: 1 }),
    } as unknown as jest.Mocked<BulkDispatchTalentumScheduler>;

    domainEventBacklogService = {
      getBacklogSummary: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<DomainEventBacklogService>;

    controller = new InternalController(
      eventProcessor,
      outboxProcessor,
      reminderScheduler,
      bulkDispatchScheduler,
      bulkDispatchTalentumScheduler,
      domainEventBacklogService,
    );
  });

  // ─── processEvent ──────────────────────────────────────────────────

  describe('processEvent', () => {
    it('decodes Pub/Sub body and dispatches to DomainEventProcessor', async () => {
      const req = mockReq(pubsubBody({ eventId: 'evt-1' }));
      const res = mockRes();

      await controller.processEvent(req, res);

      expect(eventProcessor.processEvent).toHaveBeenCalledWith('evt-1');
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('returns 400 when eventId is missing', async () => {
      const req = mockReq(pubsubBody({ wrong: 'field' }));
      const res = mockRes();

      await controller.processEvent(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Missing eventId in Pub/Sub message' });
    });

    it('returns 400 for empty body (no Pub/Sub message)', async () => {
      const req = mockReq({});
      const res = mockRes();

      await controller.processEvent(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns 500 on unexpected error', async () => {
      eventProcessor.processEvent.mockRejectedValue(new Error('db down'));
      const req = mockReq(pubsubBody({ eventId: 'evt-1' }));
      const res = mockRes();

      await controller.processEvent(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  // ─── processOutbox ─────────────────────────────────────────────────

  describe('processOutbox', () => {
    it('decodes Pub/Sub body and calls processById', async () => {
      const req = mockReq(pubsubBody({ outboxId: 'ob-1' }));
      const res = mockRes();

      await controller.processOutbox(req, res);

      expect(outboxProcessor.processById).toHaveBeenCalledWith('ob-1');
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('returns 400 when outboxId is missing', async () => {
      const req = mockReq(pubsubBody({ wrong: 'field' }));
      const res = mockRes();

      await controller.processOutbox(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns 500 on unexpected error', async () => {
      outboxProcessor.processById.mockRejectedValue(new Error('fail'));
      const req = mockReq(pubsubBody({ outboxId: 'ob-1' }));
      const res = mockRes();

      await controller.processOutbox(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  // ─── sweepReminders ───────────────────────────────────────────────

  describe('sweepReminders', () => {
    it('chama processBatch e retorna 200 com counts', async () => {
      reminderScheduler.processBatch.mockResolvedValueOnce({ dayCount: 2, minCount: 1, noShows: 3 });
      const res = mockRes();
      await controller.sweepReminders(mockReq(), res);

      expect(reminderScheduler.processBatch).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ status: 'ok', dayCount: 2, minCount: 1, noShows: 3 });
    });

    it('returns 500 on error', async () => {
      reminderScheduler.processBatch.mockRejectedValue(new Error('sweep failed'));
      const res = mockRes();
      await controller.sweepReminders(mockReq(), res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  // ─── sweepOutbox ───────────────────────────────────────────────────

  describe('sweepOutbox', () => {
    it('calls processBatch and returns 200', async () => {
      const res = mockRes();
      await controller.sweepOutbox(mockReq(), res);

      expect(outboxProcessor.processBatch).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('returns 500 on error', async () => {
      outboxProcessor.processBatch.mockRejectedValue(new Error('fail'));
      const res = mockRes();
      await controller.sweepOutbox(mockReq(), res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  // ─── sweepEvents ──────────────────────────────────────────────────

  describe('sweepEvents', () => {
    it('calls sweepPendingEvents and returns count', async () => {
      const res = mockRes();
      await controller.sweepEvents(mockReq(), res);

      expect(eventProcessor.sweepPendingEvents).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ status: 'ok', processed: 3 });
    });

    it('returns 500 on error', async () => {
      eventProcessor.sweepPendingEvents.mockRejectedValue(new Error('fail'));
      const res = mockRes();
      await controller.sweepEvents(mockReq(), res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  // ─── sweepSafeEvents ───────────────────────────────────────────────

  describe('sweepSafeEvents', () => {
    beforeEach(() => {
      // Event-aware mock: returns a distinct {processed,total} per event name,
      // so the test can prove BOTH allowlist entries were swept (not just one).
      eventProcessor.sweepPendingByEvent.mockImplementation(async (eventName: string) => {
        if (eventName === 'worker.mirror_requested') return { processed: 2, total: 3 };
        if (eventName === 'worker.registration_completed') return { processed: 1, total: 1 };
        if (eventName === 'vacancy.created') return { processed: 5, total: 7 };
        throw new Error(`unexpected event in sweep-safe: ${eventName}`);
      });
    });

    it('deletes redundant mirror events, then sweeps EACH allowlist event and sums the totals', async () => {
      const req = mockReq({}, {});
      const res = mockRes();

      await controller.sweepSafeEvents(req, res);

      expect(eventProcessor.deleteRedundantMirrorEvents).toHaveBeenCalled();
      expect(eventProcessor.sweepPendingByEvent).toHaveBeenCalledWith('worker.mirror_requested', 5, 100);
      expect(eventProcessor.sweepPendingByEvent).toHaveBeenCalledWith(
        'worker.registration_completed',
        5,
        100,
      );
      expect(eventProcessor.sweepPendingByEvent).toHaveBeenCalledWith('vacancy.created', 5, 100);
      expect(eventProcessor.sweepPendingByEvent).toHaveBeenCalledTimes(3);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        deleted: 1,
        processed: 8, // 2 + 1 + 5
        total: 11, // 3 + 1 + 7
        byEvent: {
          'worker.mirror_requested': { processed: 2, total: 3 },
          'worker.registration_completed': { processed: 1, total: 1 },
          'vacancy.created': { processed: 5, total: 7 },
        },
      });
    });

    it('sweeps exatamente o allowlist (mirror + registration_completed + vacancy.created), nada fora dele', async () => {
      const res = mockRes();
      await controller.sweepSafeEvents(mockReq(), res);

      const calledEvents = eventProcessor.sweepPendingByEvent.mock.calls.map(c => c[0]);
      // eventos sem handler (ex. funnel_stage.rejected) nunca são varridos aqui
      expect(calledEvents).not.toContain('funnel_stage.rejected');
      expect(calledEvents.sort()).toEqual(
        ['vacancy.created', 'worker.mirror_requested', 'worker.registration_completed'].sort(),
      );
    });

    it('parses olderThanMinutes/limit from query and forwards to every allowlist event', async () => {
      const req = mockReq({}, { olderThanMinutes: '10', limit: '25' });
      const res = mockRes();

      await controller.sweepSafeEvents(req, res);

      expect(eventProcessor.sweepPendingByEvent).toHaveBeenCalledWith('worker.mirror_requested', 10, 25);
      expect(eventProcessor.sweepPendingByEvent).toHaveBeenCalledWith('worker.registration_completed', 10, 25);
    });

    it('returns 400 for invalid query params', async () => {
      const req = mockReq({}, { olderThanMinutes: 'not-a-number' });
      const res = mockRes();

      await controller.sweepSafeEvents(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(eventProcessor.deleteRedundantMirrorEvents).not.toHaveBeenCalled();
      expect(eventProcessor.sweepPendingByEvent).not.toHaveBeenCalled();
    });

    it('returns 500 on unexpected error', async () => {
      eventProcessor.deleteRedundantMirrorEvents.mockRejectedValue(new Error('db down'));
      const res = mockRes();

      await controller.sweepSafeEvents(mockReq(), res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  // ─── getEventsHealth ───────────────────────────────────────────────

  describe('getEventsHealth', () => {
    it('returns summary + stuckCount + worstOldestRecentAgeMinutes with default params', async () => {
      domainEventBacklogService.getBacklogSummary.mockResolvedValue([
        {
          event: 'worker.qualified',
          pendingTotal: 2,
          pendingRecent: 2,
          oldestRecentAgeMinutes: 5,
          failedTotal: 0,
          stuck: false,
          unhandled: false,
        },
      ]);
      const req = mockReq({}, {});
      const res = mockRes();

      await controller.getEventsHealth(req, res);

      expect(domainEventBacklogService.getBacklogSummary).toHaveBeenCalledWith(6, 15, ['worker.registration_completed', 'vacancy.created']);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        summary: [
          {
            event: 'worker.qualified',
            pendingTotal: 2,
            pendingRecent: 2,
            oldestRecentAgeMinutes: 5,
            failedTotal: 0,
            stuck: false,
            unhandled: false,
          },
        ],
        stuckCount: 0,
        worstOldestRecentAgeMinutes: 5,
      });
    });

    it('parses recentWindowHours/stuckThresholdMinutes from query', async () => {
      const req = mockReq({}, { recentWindowHours: '12', stuckThresholdMinutes: '30' });
      const res = mockRes();

      await controller.getEventsHealth(req, res);

      expect(domainEventBacklogService.getBacklogSummary).toHaveBeenCalledWith(12, 30, ['worker.registration_completed', 'vacancy.created']);
    });

    it('returns 400 for invalid query params', async () => {
      const req = mockReq({}, { recentWindowHours: 'not-a-number' });
      const res = mockRes();

      await controller.getEventsHealth(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(domainEventBacklogService.getBacklogSummary).not.toHaveBeenCalled();
    });

    it('computes stuckCount from rows with stuck=true', async () => {
      domainEventBacklogService.getBacklogSummary.mockResolvedValue([
        { event: 'a', pendingTotal: 1, pendingRecent: 1, oldestRecentAgeMinutes: 20, failedTotal: 0, stuck: true, unhandled: false },
        { event: 'b', pendingTotal: 1, pendingRecent: 1, oldestRecentAgeMinutes: 2, failedTotal: 0, stuck: false, unhandled: false },
      ]);
      const res = mockRes();

      await controller.getEventsHealth(mockReq(), res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ stuckCount: 1, worstOldestRecentAgeMinutes: 20 }),
      );
    });

    it('returns 500 on unexpected error', async () => {
      domainEventBacklogService.getBacklogSummary.mockRejectedValue(new Error('db down'));
      const res = mockRes();

      await controller.getEventsHealth(mockReq(), res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  // ─── processQualifiedReminder ──────────────────────────────────────

  describe('processQualifiedReminder', () => {
    it('delegates to reminderScheduler and returns 200', async () => {
      const req = mockReq({ workerId: 'w-1', jobPostingId: 'jp-1' });
      const res = mockRes();

      await controller.processQualifiedReminder(req, res);

      expect(reminderScheduler.processQualifiedReminder).toHaveBeenCalledWith('w-1', 'jp-1');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ status: 'ok', workerId: 'w-1', jobPostingId: 'jp-1' });
    });

    it('returns 400 without workerId', async () => {
      const req = mockReq({ jobPostingId: 'jp-1' });
      const res = mockRes();

      await controller.processQualifiedReminder(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(reminderScheduler.processQualifiedReminder).not.toHaveBeenCalled();
    });

    it('returns 400 without jobPostingId', async () => {
      const req = mockReq({ workerId: 'w-1' });
      const res = mockRes();

      await controller.processQualifiedReminder(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns 500 on unexpected error', async () => {
      reminderScheduler.processQualifiedReminder.mockRejectedValue(new Error('db error'));
      const req = mockReq({ workerId: 'w-1', jobPostingId: 'jp-1' });
      const res = mockRes();

      await controller.processQualifiedReminder(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  // ─── process5MinReminder ───────────────────────────────────────────

  describe('process5MinReminder', () => {
    it('delegates to reminderScheduler and returns 200', async () => {
      const req = mockReq({ workerId: 'w-1', jobPostingId: 'jp-1' });
      const res = mockRes();

      await controller.process5MinReminder(req, res);

      expect(reminderScheduler.process5MinReminder).toHaveBeenCalledWith('w-1', 'jp-1');
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('returns 400 without required fields', async () => {
      const res = mockRes();
      await controller.process5MinReminder(mockReq({}), res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns 500 on unexpected error', async () => {
      reminderScheduler.process5MinReminder.mockRejectedValue(new Error('boom'));
      const req = mockReq({ workerId: 'w-1', jobPostingId: 'jp-1' });
      const res = mockRes();

      await controller.process5MinReminder(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  // ─── processBulkDispatch ───────────────────────────────────────────

  describe('processBulkDispatch', () => {
    it('delegates to bulkDispatchScheduler.run() and returns result', async () => {
      const res = mockRes();
      await controller.processBulkDispatch(mockReq(), res);

      expect(bulkDispatchScheduler.run).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ success: true, total: 10, sent: 8, errors: 2 });
    });

    it('returns 500 on error', async () => {
      bulkDispatchScheduler.run.mockRejectedValue(new Error('dispatch failed'));
      const res = mockRes();
      await controller.processBulkDispatch(mockReq(), res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  // ─── processBulkDispatchTalentum ───────────────────────────────────

  describe('processBulkDispatchTalentum', () => {
    it('delegates to bulkDispatchTalentumScheduler.run() and returns result', async () => {
      const res = mockRes();
      await controller.processBulkDispatchTalentum(mockReq(), res);

      expect(bulkDispatchTalentumScheduler.run).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        batchId: 'batch-t-1',
        total: 5,
        sent: 4,
        errors: 1,
      });
    });

    it('returns 500 on error', async () => {
      bulkDispatchTalentumScheduler.run.mockRejectedValue(new Error('talentum dispatch failed'));
      const res = mockRes();
      await controller.processBulkDispatchTalentum(mockReq(), res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Internal server error' });
    });
  });
});
