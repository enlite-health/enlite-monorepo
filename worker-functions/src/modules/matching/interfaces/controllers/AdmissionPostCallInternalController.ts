import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import type { AdmissionPostCallJob } from '../../application/AdmissionPostCallJob';

/**
 * `POST /api/internal/jobs/admission-post-call` — o job de 15 min da admissão (Cloud Scheduler, spec 049 F5).
 * Montado com `systemContextMiddleware('job:admission-post-call')` + `internalAuthMiddleware` (molde do F4). Devolve só
 * contagens; nunca e-mail, link, nome nem texto.
 */
export class AdmissionPostCallInternalController {
  constructor(private readonly job: AdmissionPostCallJob) {}

  async handle(_req: Request, res: Response): Promise<void> {
    try {
      const summary = await this.job.runOnce();
      res.status(200).json({ success: true, data: summary });
    } catch (err: unknown) {
      reportError(err instanceof Error ? err : new Error(String(err)), { source: 'AdmissionPostCallInternalController' });
      res.status(500).json({ success: false, error: 'Internal error' });
    }
  }
}
