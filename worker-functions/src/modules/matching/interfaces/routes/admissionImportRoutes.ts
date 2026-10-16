import { Request, Response, Router } from 'express';
import type { AdmissionImportInternalController } from '../controllers/AdmissionImportInternalController';

/** Importação do Tactiq. Montado em `/api/internal` com contexto de sistema + segredo interno no `app.use`. */
export function createAdmissionImportInternalRoutes(controller: AdmissionImportInternalController): Router {
  const router = Router();
  router.post('/jobs/admission-import', (req: Request, res: Response) => controller.handle(req, res));
  return router;
}
