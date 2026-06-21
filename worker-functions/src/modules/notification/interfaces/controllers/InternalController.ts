import { Request, Response } from 'express';
import { DomainEventProcessor } from '@shared/events/DomainEventProcessor';
import { PubSubClient } from '@shared/events/PubSubClient';
import { OutboxProcessor } from '../../infrastructure/OutboxProcessor';
import { ReminderScheduler } from '../../infrastructure/ReminderScheduler';
import { BulkDispatchScheduler } from '../../infrastructure/BulkDispatchScheduler';
import { BulkDispatchTalentumScheduler } from '../../infrastructure/BulkDispatchTalentumScheduler';
import { logger, reportError } from '@shared/logging';

/**
 * Controller for internal endpoints triggered by Pub/Sub push, Cloud Tasks, and Cloud Scheduler.
 * All endpoints are protected by InternalAuthMiddleware.
 */
export class InternalController {
  constructor(
    private readonly eventProcessor: DomainEventProcessor,
    private readonly outboxProcessor: OutboxProcessor,
    private readonly reminderScheduler: ReminderScheduler,
    private readonly bulkDispatchScheduler: BulkDispatchScheduler,
    private readonly bulkDispatchTalentumScheduler: BulkDispatchTalentumScheduler,
  ) {}

  /**
   * POST /api/internal/events/process
   * Trigger: Pub/Sub push (topic: talentum-prescreening-qualified)
   */
  async processEvent(req: Request, res: Response): Promise<void> {
    try {
      const data = PubSubClient.decodePushMessage<{ eventId: string }>(req.body);
      if (!data?.eventId) {
        res.status(400).json({ error: 'Missing eventId in Pub/Sub message' });
        return;
      }

      const result = await this.eventProcessor.processEvent(data.eventId);
      res.status(200).json(result);
    } catch (err) {
      console.error('[InternalController] processEvent error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * POST /api/internal/outbox/process
   * Trigger: Pub/Sub push (topic: outbox-enqueued)
   */
  async processOutbox(req: Request, res: Response): Promise<void> {
    try {
      const data = PubSubClient.decodePushMessage<{ outboxId: string }>(req.body);
      if (!data?.outboxId) {
        res.status(400).json({ error: 'Missing outboxId in Pub/Sub message' });
        return;
      }

      await this.outboxProcessor.processById(data.outboxId);
      res.status(200).json({ status: 'ok' });
    } catch (err) {
      console.error('[InternalController] processOutbox error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * POST /api/internal/outbox/process-paced
   * Trigger: Cloud Tasks (queue: whatsapp-paced)
   * Body: { outboxId } — direto, sem envelope Pub/Sub
   *
   * Endpoint dedicado pra Cloud Tasks com rate limit no nível da queue
   * (0.5 msg/s). Auto-invite usa este caminho pra evitar burst que
   * Meta classificaria como spam.
   */
  async processOutboxPaced(req: Request, res: Response): Promise<void> {
    try {
      const { outboxId } = req.body as { outboxId?: string };
      if (!outboxId) {
        res.status(400).json({ error: 'Missing outboxId' });
        return;
      }

      await this.outboxProcessor.processById(outboxId);
      res.status(200).json({ success: true, outboxId });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error({ error: error.message }, 'processOutboxPaced error');
      reportError(error, { source: 'InternalController:processOutboxPaced' });
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  /**
   * POST /api/internal/reminders/sweep
   * Trigger: Cloud Scheduler (every 5min) — safety net para lembretes pendentes + no-shows.
   */
  async sweepReminders(_req: Request, res: Response): Promise<void> {
    try {
      const result = await this.reminderScheduler.processBatch();
      res.status(200).json({ status: 'ok', ...result });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error({ error: error.message }, 'sweepReminders error');
      reportError(error, { source: 'InternalController:sweepReminders' });
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * POST /api/internal/outbox/sweep
   * Trigger: Cloud Scheduler (every 5min) — safety net for orphaned outbox messages.
   */
  async sweepOutbox(req: Request, res: Response): Promise<void> {
    try {
      await this.outboxProcessor.processBatch();
      res.status(200).json({ status: 'ok' });
    } catch (err) {
      console.error('[InternalController] sweepOutbox error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * POST /api/internal/events/sweep
   * Trigger: Cloud Scheduler — safety net for orphaned domain events.
   */
  async sweepEvents(req: Request, res: Response): Promise<void> {
    try {
      const processed = await this.eventProcessor.sweepPendingEvents();
      res.status(200).json({ status: 'ok', processed });
    } catch (err) {
      console.error('[InternalController] sweepEvents error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * POST /api/internal/reminders/qualified
   * Trigger: Cloud Tasks (scheduled 24h before interview)
   * Body: { workerId, jobPostingId }
   */
  async processQualifiedReminder(req: Request, res: Response): Promise<void> {
    try {
      const { workerId, jobPostingId } = req.body;
      if (!workerId || !jobPostingId) {
        res.status(400).json({ error: 'Missing workerId or jobPostingId' });
        return;
      }

      await this.reminderScheduler.processQualifiedReminder(workerId, jobPostingId);
      res.status(200).json({ status: 'ok', workerId, jobPostingId });
    } catch (err) {
      console.error('[InternalController] processQualifiedReminder error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * POST /api/internal/reminders/5min
   * Trigger: Cloud Tasks (scheduled 5min before interview)
   * Body: { workerId, jobPostingId }
   */
  async process5MinReminder(req: Request, res: Response): Promise<void> {
    try {
      const { workerId, jobPostingId } = req.body;
      if (!workerId || !jobPostingId) {
        res.status(400).json({ error: 'Missing workerId or jobPostingId' });
        return;
      }

      await this.reminderScheduler.process5MinReminder(workerId, jobPostingId);
      res.status(200).json({ status: 'ok', workerId, jobPostingId });
    } catch (err) {
      console.error('[InternalController] process5MinReminder error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * POST /api/internal/bulk-dispatch/process
   * Trigger: Cloud Scheduler (daily at 10h BRT)
   */
  async processBulkDispatch(req: Request, res: Response): Promise<void> {
    try {
      const body = (req.body ?? {}) as { dryRun?: boolean; limit?: number };
      const result = await this.bulkDispatchScheduler.run({ dryRun: body.dryRun, limit: body.limit });
      res.status(200).json({ success: true, ...result });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error({ error: error.message }, 'processBulkDispatch error');
      reportError(error, { source: 'InternalController:processBulkDispatch' });
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  /**
   * POST /api/internal/bulk-dispatch/talentum-incomplete
   * Trigger: Cloud Scheduler (daily) — lembrete para workers com prescreening Talentum
   * em INITIATED/IN_PROGRESS há >5 dias.
   */
  async processBulkDispatchTalentum(req: Request, res: Response): Promise<void> {
    try {
      const result = await this.bulkDispatchTalentumScheduler.run();
      res.status(200).json({ success: true, ...result });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error({ error: error.message }, 'processBulkDispatchTalentum error');
      reportError(error, { source: 'InternalController:bulkDispatchTalentum' });
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
}
