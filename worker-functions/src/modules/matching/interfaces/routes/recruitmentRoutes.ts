import { Router, Request, Response } from 'express';
import { RecruitmentController } from '../controllers/RecruitmentController';
import { RecruitmentAnalyticsController } from '../controllers/RecruitmentAnalyticsController';
import { RecruitmentBlockedController } from '../controllers/RecruitmentBlockedController';
import { AuthMiddleware, type PermissionMiddleware } from '@modules/identity';

/**
 * Recruitment routes.
 *
 * /api/admin/recruitment/* — requer autenticação de staff.
 *
 * As rotas /api/test/recruitment/* (duplicatas SEM AUTH, "temporário" desde a
 * criação) foram removidas em 14/08/2026 (MEDIUM do review ABAC): expunham dado
 * de recrutamento sem login e, sob RLS, seriam caminho não-classificado.
 * Evidência da remoção segura: zero hits em 30d de logs de prod, zero uso no
 * frontend; os espelhos autenticados abaixo servem os mesmos dados.
 *
 * ── Família `admin.recruitment` (task 3.5-A3) ───────────────────────────────
 * 11 rotas ao todo, 5 células, todas já no seed da 206. Dez moram aqui; a 11ª
 * (`GET /api/admin/recruitment/health`) é declarada no `src/index.ts` porque o
 * controller dela é construído a partir do `dbPool`, que só existe DEPOIS deste
 * mount — trazê-la para cá exigiria reordenar o `src/index.ts`, mudança de risco
 * silencioso que não pertence a um PR de declaração. Por isso
 * `ADMIN_RECRUITMENT_FAMILY` é exportado: a família tem que virar inteira.
 */
import { ADMIN_RECRUITMENT_FAMILY } from '@modules/identity/permissions';
export { ADMIN_RECRUITMENT_FAMILY };

export function createRecruitmentRoutes(
  recruitmentController: RecruitmentController,
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
): Router {
  const router = Router();
  const perm = permissions.family(ADMIN_RECRUITMENT_FAMILY);
  const analyticsController = new RecruitmentAnalyticsController();
  const blockedController = new RecruitmentBlockedController();

  // ── Admin recruitment routes ──────────────────────────────────────────────────
  router.get('/admin/recruitment/clickup-cases', authMiddleware.requireStaff(), perm.require('recruitment', 'read'), (req: Request, res: Response) =>
    recruitmentController.getClickUpCases(req, res),
  );
  router.get('/admin/recruitment/talentum-workers', authMiddleware.requireStaff(), perm.require('talentum', 'read'), (req: Request, res: Response) =>
    recruitmentController.getTalentumWorkers(req, res),
  );
  router.get('/admin/recruitment/progreso', authMiddleware.requireStaff(), perm.require('recruitment', 'read'), (req: Request, res: Response) =>
    recruitmentController.getProgresoWorkers(req, res),
  );
  router.get('/admin/recruitment/publications', authMiddleware.requireStaff(), perm.require('recruitment', 'read'), (req: Request, res: Response) =>
    recruitmentController.getPublications(req, res),
  );
  router.get('/admin/recruitment/encuadres', authMiddleware.requireStaff(), perm.require('match', 'read'), (req: Request, res: Response) =>
    recruitmentController.getEncuadres(req, res),
  );
  router.get('/admin/recruitment/global-metrics', authMiddleware.requireStaff(), perm.require('recruitment', 'read'), (req: Request, res: Response) =>
    analyticsController.getGlobalMetrics(req, res),
  );
  router.get('/admin/recruitment/case/:caseNumber', authMiddleware.requireStaff(), perm.require('recruitment', 'read'), (req: Request, res: Response) =>
    analyticsController.getCaseAnalysis(req, res),
  );
  router.get('/admin/recruitment/zones', authMiddleware.requireStaff(), perm.require('recruitment', 'read'), (req: Request, res: Response) =>
    analyticsController.getZoneAnalysis(req, res),
  );
  router.post('/admin/recruitment/calculate-reemplazos', authMiddleware.requireStaff(), perm.require('recruitment', 'write'), (req: Request, res: Response) =>
    analyticsController.calculateReemplazos(req, res),
  );
  // Postulaciones bloqueadas: `recruitment:read` decide; até a família virar, papel `admin`.
  router.get('/admin/recruitment/blocked-attempts', authMiddleware.requireStaff(), perm.require('recruitment', 'read', { untilEnforced: 'admin' }), (req: Request, res: Response) =>
    blockedController.listBlockedAttempts(req, res),
  );

  return router;
}
