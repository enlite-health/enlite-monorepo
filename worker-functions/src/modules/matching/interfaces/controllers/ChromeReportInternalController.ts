import { Request, Response } from 'express';
import { reportError, safeErrorFields } from '@shared/logging';
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
      // Nunca o objeto do erro: o `detail` de um erro de constraint do Postgres traz a LINHA (inclui `host_email`). Só nome, SQLSTATE e
      // constraint; o `Error` reportado é novo (sem `message`/`stack` do original) para o Error Reporting agrupar sem vazar dado.
      const { errorName, code } = safeErrorFields(err);
      const constraint = (err as { constraint?: unknown } | null)?.constraint;
      reportError(new Error(`chrome report job failed: ${errorName} ${code ?? ''}`.trim()), {
        source: 'ChromeReportInternalController',
        errorName,
        code,
        constraint: typeof constraint === 'string' ? constraint : null,
      });
      res.status(500).json({ success: false, error: 'Internal error' });
    }
  }
}
