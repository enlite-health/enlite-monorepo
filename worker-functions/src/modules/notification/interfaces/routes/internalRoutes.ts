import { Router, Request, Response } from 'express';
import { internalAuthMiddleware } from '../middleware/InternalAuthMiddleware';
import { InternalController } from '../controllers/InternalController';
import { pingVertex } from '@modules/integration/infrastructure/vertex-health';

/**
 * Routes for internal endpoints — Pub/Sub push, Cloud Tasks, Cloud Scheduler.
 * All protected by InternalAuthMiddleware (OIDC token or shared secret).
 */
export function createInternalRoutes(controller: InternalController): Router {
  const router = Router();

  router.use(internalAuthMiddleware);

  // Post-deploy smoke probe: verifies the running revision can reach Vertex AI
  // via ADC (the path that broke when the API key was revoked). The deploy
  // gate calls this and fails the rollout on non-200 — catching IAM drift,
  // region/model unavailability or broken ADC before users hit it.
  router.get('/vertex-health', async (_req: Request, res: Response) => {
    try {
      const result = await pingVertex();
      res.status(200).json({ status: 'ok', ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[VertexHealth] probe failed:', message);
      res.status(503).json({ status: 'error', error: message });
    }
  });

  // Pub/Sub push: domain events
  router.post('/events/process', (req: Request, res: Response) => {
    controller.processEvent(req, res);
  });

  // Pub/Sub push: outbox messages
  router.post('/outbox/process', (req: Request, res: Response) => {
    controller.processOutbox(req, res);
  });

  // Cloud Tasks (queue: whatsapp-paced) — rate-limited outbox processing
  router.post('/outbox/process-paced', (req: Request, res: Response) => {
    controller.processOutboxPaced(req, res);
  });

  // Cloud Scheduler safety net: orphaned outbox messages
  router.post('/outbox/sweep', (req: Request, res: Response) => {
    controller.sweepOutbox(req, res);
  });

  // Cloud Scheduler safety net: orphaned domain events
  router.post('/events/sweep', (req: Request, res: Response) => {
    controller.sweepEvents(req, res);
  });

  // Cloud Scheduler safety net: lembretes pendentes + no-shows (a cada 5min)
  router.post('/reminders/sweep', (req: Request, res: Response) => {
    controller.sweepReminders(req, res);
  });

  // Cloud Tasks: 24h reminder
  router.post('/reminders/qualified', (req: Request, res: Response) => {
    controller.processQualifiedReminder(req, res);
  });

  // Cloud Tasks: 5min reminder
  router.post('/reminders/5min', (req: Request, res: Response) => {
    controller.process5MinReminder(req, res);
  });

  // Cloud Scheduler: daily bulk dispatch
  router.post('/bulk-dispatch/process', (req: Request, res: Response) => {
    controller.processBulkDispatch(req, res);
  });

  // Cloud Scheduler: daily Talentum incomplete reminder
  router.post('/bulk-dispatch/talentum-incomplete', (req: Request, res: Response) => {
    controller.processBulkDispatchTalentum(req, res);
  });

  return router;
}
