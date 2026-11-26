import { Router, Request, Response } from 'express';
import { routeClass } from '@modules/identity/permissions';
import { PresenceAlertsInternalController } from '../controllers/PresenceAlertsInternalController';

/**
 * Montada em `/api/internal` com `systemContextMiddleware('job:presence-alerts')` + `internalAuthMiddleware` (`X-Internal-Secret`) no `app.use`
 * (molde do "Sin cubrir", `itineraryDailyInternalRoutes.ts`): o guard de segredo NÃO é por rota.
 */
export function createPresenceAlertsInternalRoutes(controller: PresenceAlertsInternalController): Router {
  const router = Router();
  router.post('/presence/alerts', routeClass('service'), (req: Request, res: Response) => controller.handle(req, res));
  return router;
}
