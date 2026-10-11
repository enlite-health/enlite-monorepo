import { Router, Request, Response } from 'express';
import { ChromeReportInternalController } from '../controllers/ChromeReportInternalController';

/** Job diário do relatório do Chrome. Montado em `/api/internal` com contexto de sistema + segredo interno no `app.use`. */
export function createChromeReportInternalRoutes(controller: ChromeReportInternalController): Router {
  const router = Router();
  router.post('/jobs/admission-chrome-report', (req: Request, res: Response) => controller.handle(req, res));
  return router;
}
