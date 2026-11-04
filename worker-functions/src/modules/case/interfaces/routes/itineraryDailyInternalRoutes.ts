import { Router, Request, Response } from 'express';
import { ItineraryDailyInternalController } from '../controllers/ItineraryDailyInternalController';

/**
 * Montada em `/api/internal` com `systemContextMiddleware('job:itinerary-daily')` + `internalAuthMiddleware` no `app.use` (molde do PT,
 * `index.ts`) — o guard de segredo NÃO é por rota. Router próprio no módulo `case`: o módulo `notification` (dono do `/api/internal`)
 * não importa `case`.
 */
export function createItineraryDailyInternalRoutes(controller: ItineraryDailyInternalController): Router {
  const router = Router();
  router.post('/itinerary/daily', (req: Request, res: Response) => controller.handle(req, res));
  return router;
}
