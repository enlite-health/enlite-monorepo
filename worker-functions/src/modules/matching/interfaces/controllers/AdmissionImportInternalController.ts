import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import type { ImportSummary } from '../../application/admissionImportTypes';

/** Só o que o controller usa do serviço: a importação da admissão e a do enquadre (spec 052) são a mesma classe sobre sujeitos diferentes. */
export interface ImportRunner {
  runOnce(): Promise<ImportSummary>;
}

/**
 * `POST /api/internal/jobs/admission-import` — a importação do Tactiq (Cloud Scheduler, spec 049 F6). Montado com
 * `systemContextMiddleware('job:admission-import')` + `internalAuthMiddleware`. Devolve só contagens; nunca e-mail, link, nome nem texto.
 */
export class AdmissionImportInternalController {
  constructor(private readonly service: ImportRunner) {}

  async handle(_req: Request, res: Response): Promise<void> {
    try {
      const summary = await this.service.runOnce();
      res.status(200).json({ success: true, data: summary });
    } catch (err: unknown) {
      reportError(err instanceof Error ? err : new Error(String(err)), { source: 'AdmissionImportInternalController' });
      res.status(500).json({ success: false, error: 'Internal error' });
    }
  }
}
