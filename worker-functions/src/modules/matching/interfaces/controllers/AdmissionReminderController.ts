import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { AdmissionReminderService } from '../../application/AdmissionReminderService';

/**
 * AdmissionReminderController — internal endpoint handler for the 30-min
 * admission reminder Cloud Task.
 *
 *   POST /api/internal/reminders/admission-30min   body: { appointmentId }
 *
 * Protected by internalAuthMiddleware (X-Internal-Secret) at wiring time.
 */
export class AdmissionReminderController {
  constructor(private readonly service: AdmissionReminderService) {}

  async handle(req: Request, res: Response): Promise<void> {
    const { appointmentId } = req.body as { appointmentId?: string };
    if (!appointmentId) {
      res.status(400).json({ error: 'Missing appointmentId' });
      return;
    }

    try {
      const result = await this.service.send30MinReminder(appointmentId);
      res.status(200).json({ status: 'ok', ...result });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdmissionReminderController:handle' });
      res.status(500).json({ error: 'Internal server error' });
    }
  }
}
