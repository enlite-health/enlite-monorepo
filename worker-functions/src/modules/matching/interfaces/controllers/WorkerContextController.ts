import { Request, Response } from 'express';
import { z } from 'zod';
import { GetCurrentInterviewUseCase } from '../../application/GetCurrentInterviewUseCase';
import { ListAvailableVacanciesForWorkerUseCase } from '../../application/ListAvailableVacanciesForWorkerUseCase';
import { IngestDocumentFromUrlUseCase, WorkerNotFoundError, HostBlockedError, FileTooLargeError, ContentTypeMismatchError, DownloadError } from '@modules/worker/application/IngestDocumentFromUrlUseCase';
import { logger, reportError } from '@shared/logging';

const IngestBodySchema = z.object({
  documentType: z.string().min(1),
  externalUrl: z.string().url(),
});

/**
 * WorkerContextController
 *
 * Handlers para os 3 endpoints do triage-service:
 *   GET  /workers/:id/current-interview
 *   GET  /workers/:id/available-vacancies
 *   POST /workers/:id/documents/ingest-from-url
 *
 * Responsabilidade exclusiva: parse/validate + delegar ao use case.
 */
export class WorkerContextController {
  private readonly getCurrentInterview = new GetCurrentInterviewUseCase();
  private readonly listAvailableVacancies = new ListAvailableVacanciesForWorkerUseCase();
  private readonly ingestDocument = new IngestDocumentFromUrlUseCase();

  async currentInterview(req: Request, res: Response): Promise<void> {
    const { id: workerId } = req.params;
    const log = logger.child({ workerId, handler: 'currentInterview' });

    try {
      const result = await this.getCurrentInterview.execute(workerId);
      res.status(200).json(result);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'WorkerContextController:currentInterview', workerId });
      log.error({ msg: 'unexpected error', error: e.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async availableVacancies(req: Request, res: Response): Promise<void> {
    const { id: workerId } = req.params;
    const log = logger.child({ workerId, handler: 'availableVacancies' });

    try {
      const result = await this.listAvailableVacancies.execute(workerId);
      res.status(200).json(result);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'WorkerContextController:availableVacancies', workerId });
      log.error({ msg: 'unexpected error', error: e.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async ingestFromUrl(req: Request, res: Response): Promise<void> {
    const { id: workerId } = req.params;
    const log = logger.child({ workerId, handler: 'ingestFromUrl' });

    const parsed = IngestBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
      return;
    }

    const { documentType, externalUrl } = parsed.data;

    try {
      const result = await this.ingestDocument.execute({ workerId, documentType, externalUrl });
      res.status(201).json(result);
    } catch (err) {
      if (err instanceof WorkerNotFoundError) {
        res.status(404).json({ error: 'Worker not found' });
        return;
      }
      if (err instanceof HostBlockedError) {
        res.status(422).json({ error: 'Host blocked', detail: err.message });
        return;
      }
      if (err instanceof FileTooLargeError) {
        res.status(413).json({ error: 'File too large (max 10MB)' });
        return;
      }
      if (err instanceof ContentTypeMismatchError) {
        res.status(422).json({ error: 'Content-type not supported', detail: err.message });
        return;
      }
      if (err instanceof DownloadError) {
        res.status(502).json({ error: 'Download or upload failed', detail: err.message });
        return;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'WorkerContextController:ingestFromUrl', workerId });
      log.error({ msg: 'unexpected error', error: e.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  }
}
