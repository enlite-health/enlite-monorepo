import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { operationDateInZone } from '@shared/locale/operationDate';
import { GetWorkerItineraryUseCase, AccountInactiveError } from '../../application/GetWorkerItineraryUseCase';

/** UTC−3 (Buenos Aires): data civil do "hoje" da janela [dia 1 do mês anterior, hoje+14] (FR-42). */
const TODAY_ZONE = 'America/Argentina/Buenos_Aires';

/**
 * WorkerItineraryMeController — `GET /api/workers/me/itinerary` (spec 077 F1).
 * Identidade SÓ de `req.user.uid` (posto por `requireAuth()`); nenhum header de identidade é lido.
 */
export class WorkerItineraryMeController {
  constructor(private readonly useCase: GetWorkerItineraryUseCase = new GetWorkerItineraryUseCase()) {}

  async getMine(req: Request, res: Response): Promise<void> {
    const uid = req.user?.uid;
    if (!uid) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    try {
      const envelope = await this.useCase.execute({ uid, today: operationDateInZone(TODAY_ZONE, new Date()) });
      res.status(200).json(envelope);
    } catch (err) {
      if (err instanceof AccountInactiveError) {
        res.status(403).json({ code: 'ACCOUNT_INACTIVE' });
        return;
      }
      reportError(err as Error, { source: 'WorkerItineraryMeController:getMine' });
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
}
