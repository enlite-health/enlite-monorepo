/**
 * AnaCareBackfillController — POST /integrations/anacare/backfill
 *
 * Dispara o espelhamento de workers elegíveis para o AnaCare.
 * Não contém lógica de negócio — delega para BackfillWorkerMirrorUseCase.
 */

import { Request, Response } from 'express';
import { z } from 'zod';
import { BackfillWorkerMirrorUseCase } from '../../application/BackfillWorkerMirrorUseCase';
import { AnaCareMirrorProvider } from '../../infrastructure/anacare/AnaCareMirrorProvider';
import { AnaCareClient } from '../../infrastructure/anacare/AnaCareClient';
import { logger, reportError } from '@shared/logging';

const TAG = '[AnaCareBackfill]';

const BackfillBodySchema = z.object({
  dryRun: z.boolean().optional(),
  limit: z.number().int().positive().max(5000).optional(),
});

export class AnaCareBackfillController {
  async handle(req: Request, res: Response): Promise<void> {
    const parsed = BackfillBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid request body',
        details: parsed.error.flatten(),
      });
      return;
    }

    const { dryRun, limit } = parsed.data;

    try {
      // Provider lazy: AnaCareClient.create() (Secret Manager) só é chamado
      // quando há upsert real (dryRun=false). dryRun não toca em creds externas.
      const useCase = new BackfillWorkerMirrorUseCase(
        async () => new AnaCareMirrorProvider(await AnaCareClient.create()),
      );

      const summary = await useCase.execute({ dryRun, limit });

      logger.info({ msg: `${TAG} backfill completed`, dryRun, ...summary });

      res.status(200).json({ success: true, data: summary });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: `${TAG}:handle` });
      logger.error({ msg: `${TAG} backfill failed`, error: e.message });
      res.status(500).json({ success: false, error: e.message });
    }
  }
}
