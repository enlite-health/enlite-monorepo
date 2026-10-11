import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { ChromeReportJob } from '../../application/ChromeReportJob';

/**
 * `POST /api/internal/jobs/admission-chrome-report` — o relatório diário do Chrome (spec 050 F15). Montado com
 * `systemContextMiddleware('job:admission-chrome-report')` + `internalAuthMiddleware`. Devolve só contagens; nunca e-mail nem id.
 */
export class ChromeReportInternalController {
  constructor(private readonly job: ChromeReportJob) {}

  async handle(_req: Request, res: Response): Promise<void> {
    try {
      const summary = await this.job.run();
      res.status(200).json({ success: true, data: summary });
    } catch (err: unknown) {
      reportError(err instanceof Error ? err : new Error(String(err)), { source: 'ChromeReportInternalController' });
      res.status(500).json({ success: false, error: 'Internal error' });
    }
  }
}
