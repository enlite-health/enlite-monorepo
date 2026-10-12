import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import type { AdmissionLiveJob } from '../../application/AdmissionLiveJob';

/**
 * `POST /api/internal/jobs/admission-live` — o job de 1 minuto da admissão (spec 050, 4º passo). Montado com
 * `systemContextMiddleware('job:admission-live')` + `internalAuthMiddleware` (molde do post-call). Devolve só contagens.
 */
export class AdmissionLiveInternalController {
  constructor(private readonly job: AdmissionLiveJob) {}

  async handle(_req: Request, res: Response): Promise<void> {
    try {
      const summary = await this.job.runOnce();
      res.status(200).json({ success: true, data: summary });
    } catch (err: unknown) {
      reportError(err instanceof Error ? err : new Error(String(err)), { source: 'AdmissionLiveInternalController' });
      res.status(500).json({ success: false, error: 'Internal error' });
    }
  }
}
