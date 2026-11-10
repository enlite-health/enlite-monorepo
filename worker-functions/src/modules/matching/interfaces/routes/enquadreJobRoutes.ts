import { Request, Response, Router } from 'express';
import { routeClass } from '@modules/identity/permissions';
import type { AdmissionPostCallInternalController } from '../controllers/AdmissionPostCallInternalController';
import type { AdmissionImportInternalController } from '../controllers/AdmissionImportInternalController';

/** Job de 15 min do fim de call do enquadre. Montado em `/api/internal` com contexto de sistema + segredo interno no `app.use`. */
export function createEnquadrePostCallInternalRoutes(controller: AdmissionPostCallInternalController): Router {
  const router = Router();
  router.post('/jobs/enquadre-post-call', routeClass('service'), (req: Request, res: Response) => controller.handle(req, res));
  return router;
}

/** Job de 15 min da importação do Tactiq do enquadre. Mesmo padrão: contexto de sistema + segredo interno no `app.use`. */
export function createEnquadreImportInternalRoutes(controller: AdmissionImportInternalController): Router {
  const router = Router();
  router.post('/jobs/enquadre-import', routeClass('service'), (req: Request, res: Response) => controller.handle(req, res));
  return router;
}
