import { Router, Request, Response } from 'express';
import { AuthMiddleware, type PermissionMiddleware } from '@modules/identity';
import { ADMIN_PATIENTS_FAMILY } from '@modules/identity/permissions';
import { AdminServiceTeamContactController } from '../controllers/AdminServiceTeamContactController';

/**
 * Rotas do modal do prestador (quadro C — rodada 2, decisão D do brief). Router PRÓPRIO, separado
 * de `adminServiceTeamRoutes.ts`: aquele tem um teste que trava em "exatamente 3 rotas" (invariante
 * 1 — nenhum POST de adicionar ao TIME); este POST é outra coisa (registrar contato, append-only,
 * nunca move coluna), e não cabe nessa contagem sem reabrir aquele contrato.
 *
 * Células (mesmas do quadro C, DX-10.1): leitura sob `patient_services:read`; a escrita (registrar
 * contato) sob `patient_service_team:update` — a MESMA que já governa rejeitar/reverter, porque o
 * modal é a MESMA superfície de ação sobre o time do serviço.
 */
export function createAdminServiceTeamContactRoutes(
  controller: AdminServiceTeamContactController,
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
): Router {
  const router = Router();
  const staffOnly = authMiddleware.requireStaff();
  const perm = permissions.family(ADMIN_PATIENTS_FAMILY);

  router.get(
    '/patients/:id/contracted-services/:sid/team/:workerId/contact',
    staffOnly,
    perm.require('patient_services', 'read'),
    (req: Request, res: Response) => controller.get(req, res),
  );
  router.post(
    '/patients/:id/contracted-services/:sid/team/:workerId/contact',
    staffOnly,
    perm.require('patient_service_team', 'update'),
    (req: Request, res: Response) => controller.register(req, res),
  );

  return router;
}
