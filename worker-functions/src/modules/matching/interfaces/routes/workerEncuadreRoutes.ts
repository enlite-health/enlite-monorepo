import { Router, Request, Response } from 'express';
import { EncuadreController } from '../controllers/EncuadreController';
import { AuthMiddleware } from '@modules/identity';

/**
 * Worker status & encuadre routes — /api/workers/* and /api/cases/*
 *
 * Staff-only: são dashboards de operação, escrita de status de funil e leituras
 * cross-worker por :id — nada aqui é "o worker sobre si mesmo" (isso vive em
 * /api/workers/me/*). Com requireAuth() genérico, qualquer worker autenticado
 * alcançava tecnicamente escrita de funil de terceiros.
 */
export function createWorkerEncuadreRoutes(
  encuadreController: EncuadreController,
  authMiddleware: AuthMiddleware,
): Router {
  const router = Router();
  const auth = authMiddleware.requireStaff();

  router.get('/workers/status-dashboard', auth, (req: Request, res: Response) =>
    encuadreController.getStatusDashboard(req, res),
  );
  router.get('/workers/by-status/:status', auth, (req: Request, res: Response) =>
    encuadreController.getWorkersByStatus(req, res),
  );
  router.put('/workers/:id/status', auth, (req: Request, res: Response) =>
    encuadreController.updateWorkerStatus(req, res),
  );
  router.put('/workers/:id/occupation', auth, (req: Request, res: Response) =>
    encuadreController.updateOccupation(req, res),
  );
  router.get('/workers/docs-expiring', auth, (req: Request, res: Response) =>
    encuadreController.getDocsExpiringSoon(req, res),
  );
  router.put('/workers/:id/doc-expiry', auth, (req: Request, res: Response) =>
    encuadreController.updateDocExpiry(req, res),
  );
  router.get('/workers/:id/encuadres', auth, (req: Request, res: Response) =>
    encuadreController.getWorkerEncuadres(req, res),
  );
  router.get('/workers/:id/cases', auth, (req: Request, res: Response) =>
    encuadreController.getWorkerCases(req, res),
  );
  router.get('/cases/:caseNumber/encuadres', auth, (req: Request, res: Response) =>
    encuadreController.getCaseEncuadres(req, res),
  );
  router.get('/cases/:caseNumber/workers', auth, (req: Request, res: Response) =>
    encuadreController.getCaseWorkers(req, res),
  );

  return router;
}
