import { Request, Response, Router } from 'express';
import type { AdmissionPostCallInternalController } from '../controllers/AdmissionPostCallInternalController';

/** Job de 15 min da admissão. Montado em `/api/internal` com contexto de sistema + segredo interno no `app.use`. */
export function createAdmissionPostCallInternalRoutes(controller: AdmissionPostCallInternalController): Router {
  const router = Router();
  router.post('/jobs/admission-post-call', (req: Request, res: Response) => controller.handle(req, res));
  return router;
}
