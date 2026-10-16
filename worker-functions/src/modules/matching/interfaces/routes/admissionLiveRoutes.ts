import { Request, Response, Router } from 'express';
import type { AdmissionLiveInternalController } from '../controllers/AdmissionLiveInternalController';

/** Job de 1 minuto da admissão. Montado em `/api/internal` com contexto de sistema + segredo interno no `app.use`. */
export function createAdmissionLiveInternalRoutes(controller: AdmissionLiveInternalController): Router {
  const router = Router();
  router.post('/jobs/admission-live', (req: Request, res: Response) => controller.handle(req, res));
  return router;
}
