import { Request, Response, Router } from 'express';
import type { AdmissionPostCallInternalController } from '../controllers/AdmissionPostCallInternalController';

/** Job de 15 min do fim de call do enquadre. Montado em `/api/internal` com contexto de sistema + segredo interno no `app.use`. */
export function createEnquadrePostCallInternalRoutes(controller: AdmissionPostCallInternalController): Router {
  const router = Router();
  router.post('/jobs/enquadre-post-call', (req: Request, res: Response) => controller.handle(req, res));
  return router;
}
