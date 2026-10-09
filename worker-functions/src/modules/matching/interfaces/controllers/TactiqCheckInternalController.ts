import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { TactiqLinkService } from '../../application/TactiqLinkService';

/**
 * `POST /api/internal/jobs/admission-tactiq-check` — o teste diário do vínculo do Tactiq (Cloud Scheduler, spec 049 F4).
 * Montado com `systemContextMiddleware('job:admission-tactiq-check')` + `internalAuthMiddleware` (molde do PT). Devolve só
 * contagens; nunca token, e-mail nem nome.
 */
export class TactiqCheckInternalController {
  constructor(private readonly service: TactiqLinkService) {}

  async handle(_req: Request, res: Response): Promise<void> {
    try {
      const summary = await this.service.runDailyCheck();
      res.status(200).json({ success: true, data: summary });
    } catch (err: unknown) {
      reportError(err instanceof Error ? err : new Error(String(err)), { source: 'TactiqCheckInternalController' });
      res.status(500).json({ success: false, error: 'Internal error' });
    }
  }
}
