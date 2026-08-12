import { Request, Response } from 'express';
import { Pool } from 'pg';
import { z } from 'zod';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { reportError } from '@shared/logging';
import { getWorkerVacancyDeliveryStatus } from './workerVacancyDeliveryStatusHelper';

const ParamsSchema = z.object({
  vacancyId: z.string().uuid(),
  workerId: z.string().uuid(),
});

/**
 * WorkerVacancyDeliveryStatusController
 *
 * GET /api/admin/vacancies/:vacancyId/workers/:workerId/delivery-status → 200
 *
 * READ-ONLY. Expõe o estágio do funil (WJA) + o status de entrega mais
 * recente do messaging_outbox pro par (worker, vaga). Usado pelo E2E do
 * funil de WhatsApp pra verificar entrega sem tocar no banco direto.
 * Lógica delegada a workerVacancyDeliveryStatusHelper (limite de 400 linhas).
 */
export class WorkerVacancyDeliveryStatusController {
  private db: Pool;

  constructor() {
    this.db = DatabaseConnection.getInstance().getPool();
  }

  async getDeliveryStatus(req: Request, res: Response): Promise<void> {
    const parsed = ParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Invalid params', details: parsed.error.flatten() });
      return;
    }

    const { vacancyId, workerId } = parsed.data;

    try {
      const result = await getWorkerVacancyDeliveryStatus(this.db, workerId, vacancyId);

      if (result.kind === 'not_found') {
        res.status(404).json({ success: false, error: 'Worker job application not found' });
        return;
      }

      res.status(200).json({
        success: true,
        data: {
          wjaStage: result.wjaStage,
          outbox: result.outbox,
        },
      });
    } catch (error) {
      const e = error instanceof Error ? error : new Error(String(error));
      reportError(e, { source: 'WorkerVacancyDeliveryStatusController:getDeliveryStatus', workerId, vacancyId });
      res.status(500).json({ success: false, error: e.message });
    }
  }
}
