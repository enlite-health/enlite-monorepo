import { Router, Request, Response } from 'express';
import { TherapeuticContactRemindersInternalController } from '../controllers/TherapeuticContactRemindersInternalController';

/**
 * Montada em `/api/internal` com `systemContextMiddleware('job:pt-contact-reminders')` + `internalAuthMiddleware` no
 * `app.use` (molde do Ana Care Horas, `index.ts`) — o guard de segredo NÃO é por rota. Router próprio no módulo `case`:
 * o módulo `notification` (dono do `/api/internal`) não importa `case`.
 */
export function createTherapeuticContactRemindersInternalRoutes(controller: TherapeuticContactRemindersInternalController): Router {
  const router = Router();
  router.post('/therapeutic-projects/contact-reminders/sweep', (req: Request, res: Response) => controller.handle(req, res));
  return router;
}
