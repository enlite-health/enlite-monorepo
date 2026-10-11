import { Router, Request, Response } from 'express';
import { RecruitmentBlockedController } from '../controllers/RecruitmentBlockedController';
import { AuthMiddleware, type PermissionMiddleware } from '@modules/identity';

/**
 * Recruitment routes.
 *
 * /api/admin/recruitment/* — requer autenticação de staff.
 *
 * Resta aqui só `GET /api/admin/recruitment/blocked-attempts` (log de postulações bloqueadas).
 * O dashboard de recrutamento (clickup-cases, talentum-workers, progreso, publications,
 * encuadres, global-metrics, case/:caseNumber, zones, calculate-reemplazos) e a rota
 * `/health` foram removidos junto com as telas `/admin/recruitment` e
 * `/admin/recruitment/health`.
 *
 * As rotas /api/test/recruitment/* (duplicatas SEM AUTH) já tinham sido removidas em 14/08/2026.
 *
 * Família `admin.recruitment`: continua existindo (é o nome que PERMISSION_ENFORCED_ROUTES liga)
 * e hoje contém só a rota de bloqueadas.
 */
import { ADMIN_RECRUITMENT_FAMILY } from '@modules/identity/permissions';
export { ADMIN_RECRUITMENT_FAMILY };

export function createRecruitmentRoutes(
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
): Router {
  const router = Router();
  const perm = permissions.family(ADMIN_RECRUITMENT_FAMILY);
  const blockedController = new RecruitmentBlockedController();

  // Postulaciones bloqueadas: spec 024 D2/D401 — LOG administrativo, dado diferente do funil de
  // recrutamento; célula própria `recruitment_blocked:read` decide; até a família virar, papel `admin`.
  router.get('/admin/recruitment/blocked-attempts', authMiddleware.requireStaff(), perm.require('recruitment_blocked', 'read', { untilEnforced: 'admin' }), (req: Request, res: Response) =>
    blockedController.listBlockedAttempts(req, res),
  );

  return router;
}
