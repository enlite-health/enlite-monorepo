import { Router, Request, Response } from 'express';
import { AnalyticsController } from '../controllers/AnalyticsController';
import { AuthMiddleware } from '@modules/identity';

/**
 * Analytics & BI routes — /analytics/*
 * Todos os endpoints exigem autenticação de staff.
 * IMPORTANTE: rotas estáticas antes das dinâmicas para evitar captura pelo param.
 */
export function createAnalyticsRoutes(
  analyticsController: AnalyticsController,
  authMiddleware: AuthMiddleware,
): Router {
  const router = Router();

  router.get('/workers', authMiddleware.requireStaff(), (req: Request, res: Response) =>
    analyticsController.getWorkerStats(req, res),
  );

  router.get('/workers/missing-documents', authMiddleware.requireStaff(), (req: Request, res: Response) =>
    analyticsController.getWorkersMissingDocuments(req, res),
  );

  router.get('/workers/:workerId/vacancies', authMiddleware.requireStaff(), (req: Request, res: Response) =>
    analyticsController.getWorkerVacancyEngagement(req, res),
  );

  router.get('/vacancies', authMiddleware.requireStaff(), (req: Request, res: Response) =>
    analyticsController.listVacancies(req, res),
  );

  // Estática /case/:caseNumber antes da dinâmica /:id
  router.get('/vacancies/case/:caseNumber', authMiddleware.requireStaff(), (req: Request, res: Response) =>
    analyticsController.getVacancyByCaseNumber(req, res),
  );

  router.get('/vacancies/:id/incomplete-registrations', authMiddleware.requireStaff(), (req: Request, res: Response) =>
    analyticsController.getVacancyIncompleteRegistrations(req, res),
  );

  router.get('/vacancies/:id', authMiddleware.requireStaff(), (req: Request, res: Response) =>
    analyticsController.getVacancyById(req, res),
  );

  router.get('/dedup/candidates', authMiddleware.requireStaff(), (req: Request, res: Response) =>
    analyticsController.getDedupCandidates(req, res),
  );

  router.post('/dedup/run', authMiddleware.requireAdmin(), (req: Request, res: Response) =>
    analyticsController.runDeduplication(req, res),
  );

  // Dashboard endpoints — estáticas /global, /zones, /reemplazos antes da paramétrica /cases/:caseNumber
  router.get('/dashboard/global', authMiddleware.requireStaff(), (req: Request, res: Response) =>
    analyticsController.getGlobalMetrics(req, res),
  );

  router.get('/dashboard/zones', authMiddleware.requireStaff(), (req: Request, res: Response) =>
    analyticsController.getZoneMetrics(req, res),
  );

  router.get('/dashboard/reemplazos', authMiddleware.requireStaff(), (req: Request, res: Response) =>
    analyticsController.getReemplazosMetrics(req, res),
  );

  router.get('/dashboard/management', authMiddleware.requireStaff(), (req: Request, res: Response) =>
    analyticsController.getManagementMetrics(req, res),
  );

  router.get('/dashboard/cases/:caseNumber', authMiddleware.requireStaff(), (req: Request, res: Response) =>
    analyticsController.getCaseMetrics(req, res),
  );

  return router;
}
