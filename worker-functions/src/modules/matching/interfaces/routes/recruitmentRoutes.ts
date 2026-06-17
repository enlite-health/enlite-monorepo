import { Router, Request, Response } from 'express';
import { RecruitmentController } from '../controllers/RecruitmentController';
import { RecruitmentAnalyticsController } from '../controllers/RecruitmentAnalyticsController';
import { RecruitmentBlockedController } from '../controllers/RecruitmentBlockedController';
import { AuthMiddleware } from '@modules/identity';

/**
 * Recruitment routes.
 *
 * /api/admin/recruitment/* — requer autenticação de staff.
 * /api/test/recruitment/*  — sem auth (temporário, remover em produção).
 */
export function createRecruitmentRoutes(
  recruitmentController: RecruitmentController,
  authMiddleware: AuthMiddleware,
): Router {
  const router = Router();
  const analyticsController = new RecruitmentAnalyticsController();
  const blockedController = new RecruitmentBlockedController();

  // ── Temporary test routes (No Auth) ──────────────────────────────────────────
  // TODO: Remove in production
  router.get('/test/recruitment/clickup-cases', (req: Request, res: Response) =>
    recruitmentController.getClickUpCases(req, res),
  );
  router.get('/test/recruitment/talentum-workers', (req: Request, res: Response) =>
    recruitmentController.getTalentumWorkers(req, res),
  );
  router.get('/test/recruitment/progreso', (req: Request, res: Response) =>
    recruitmentController.getProgresoWorkers(req, res),
  );
  router.get('/test/recruitment/publications', (req: Request, res: Response) =>
    recruitmentController.getPublications(req, res),
  );
  router.get('/test/recruitment/encuadres', (req: Request, res: Response) =>
    recruitmentController.getEncuadres(req, res),
  );
  router.get('/test/recruitment/global-metrics', (req: Request, res: Response) =>
    analyticsController.getGlobalMetrics(req, res),
  );

  // ── Admin recruitment routes ──────────────────────────────────────────────────
  router.get('/admin/recruitment/clickup-cases', authMiddleware.requireStaff(), (req: Request, res: Response) =>
    recruitmentController.getClickUpCases(req, res),
  );
  router.get('/admin/recruitment/talentum-workers', authMiddleware.requireStaff(), (req: Request, res: Response) =>
    recruitmentController.getTalentumWorkers(req, res),
  );
  router.get('/admin/recruitment/progreso', authMiddleware.requireStaff(), (req: Request, res: Response) =>
    recruitmentController.getProgresoWorkers(req, res),
  );
  router.get('/admin/recruitment/publications', authMiddleware.requireStaff(), (req: Request, res: Response) =>
    recruitmentController.getPublications(req, res),
  );
  router.get('/admin/recruitment/encuadres', authMiddleware.requireStaff(), (req: Request, res: Response) =>
    recruitmentController.getEncuadres(req, res),
  );
  router.get('/admin/recruitment/global-metrics', authMiddleware.requireStaff(), (req: Request, res: Response) =>
    analyticsController.getGlobalMetrics(req, res),
  );
  router.get('/admin/recruitment/case/:caseNumber', authMiddleware.requireStaff(), (req: Request, res: Response) =>
    analyticsController.getCaseAnalysis(req, res),
  );
  router.get('/admin/recruitment/zones', authMiddleware.requireStaff(), (req: Request, res: Response) =>
    analyticsController.getZoneAnalysis(req, res),
  );
  router.post('/admin/recruitment/calculate-reemplazos', authMiddleware.requireStaff(), (req: Request, res: Response) =>
    analyticsController.calculateReemplazos(req, res),
  );
  router.get('/admin/recruitment/blocked-attempts', authMiddleware.requireStaff(), (req: Request, res: Response) =>
    blockedController.listBlockedAttempts(req, res),
  );

  return router;
}
