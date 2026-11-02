import { Router, Request, Response } from 'express';
import { RecruitmentBlockedController } from '../controllers/RecruitmentBlockedController';
import { RecruiterActivityController } from '../controllers/RecruiterActivityController';
import { AuthMiddleware, type PermissionMiddleware } from '@modules/identity';

/**
 * Recruitment routes.
 *
 * /api/admin/recruitment/* — requer autenticação de staff.
 *
 * Restam aqui `GET /api/admin/recruitment/blocked-attempts` (log de postulações bloqueadas) e
 * `GET /api/admin/recruitment/activity-per-person` (spec 081 T064b: contagens de atividade por recrutadora e semana).
 * O dashboard de recrutamento (clickup-cases, talentum-workers, progreso, publications,
 * encuadres, global-metrics, case/:caseNumber, zones, calculate-reemplazos) e a rota
 * `/health` foram removidos junto com as telas `/admin/recruitment` e
 * `/admin/recruitment/health`.
 *
 * As rotas /api/test/recruitment/* (duplicatas SEM AUTH) já tinham sido removidas em 14/08/2026.
 *
 * Família `admin.recruitment`: continua existindo (é o nome que PERMISSION_ENFORCED_ROUTES liga)
 * e hoje contém só as duas rotas acima.
 */
import { ADMIN_RECRUITMENT_FAMILY } from '@modules/identity/permissions';
export { ADMIN_RECRUITMENT_FAMILY };

export function createRecruitmentRoutes(
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
  activityController: RecruiterActivityController = new RecruiterActivityController(),
): Router {
  const router = Router();
  const perm = permissions.family(ADMIN_RECRUITMENT_FAMILY);
  const blockedController = new RecruitmentBlockedController();

  // Postulaciones bloqueadas: spec 024 D2/D401 — LOG administrativo, dado diferente do funil de
  // recrutamento; célula própria `recruitment_blocked:read` decide; até a família virar, papel `admin`.
  router.get('/admin/recruitment/blocked-attempts', authMiddleware.requireStaff(), perm.require('recruitment_blocked', 'read', { untilEnforced: 'admin' }), (req: Request, res: Response) =>
    blockedController.listBlockedAttempts(req, res),
  );

  // Atividade por recrutadora (spec 081 T064b, D602a): SÓ contagens, uid opaco, sem e-mail. Célula do Acesso Master;
  // `untilEnforced: 'admin'` fecha o intervalo com a família ainda não enforced (sem ele, qualquer staff passaria).
  router.get('/admin/recruitment/activity-per-person', authMiddleware.requireStaff(), perm.require('recruitment_activity_per_person', 'read', { untilEnforced: 'admin' }), (req: Request, res: Response) =>
    activityController.list(req, res),
  );

  return router;
}
