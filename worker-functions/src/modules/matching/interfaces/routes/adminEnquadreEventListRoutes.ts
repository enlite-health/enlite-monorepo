import { Router, Request, Response } from 'express';
import { AuthMiddleware, type PermissionMiddleware } from '@modules/identity';
import { ADMIN_VACANCIES_FAMILY } from '@modules/identity/permissions';
import { EnquadreEventListController } from '../controllers/EnquadreEventListController';

/**
 * Lista GLOBAL de enquadres (spec 076): uma rota, cross-vacante, num router PRÓPRIO (não muda a assinatura de
 * `createAdminEnquadreEventRoutes`). Montada sob `/api/admin`, família `admin.vacancies`, a mesma das rotas do enquadre.
 *
 * DUAS células encadeadas, LITERAIS (o scanner do catálogo só reconhece strings literais e lista todas, na ordem dos guards):
 *  - `enquadre_event:read` — o evento.
 *  - `vacancy:read`        — a lista cruza vagas e devolve o caso de cada uma: quem não lê a vaga não lista os casos.
 * Falta qualquer uma → 403 do guard. `staffOnly` SEMPRE antes de `perm.require`. Rota ESTÁTICA, router próprio: nada de
 * `/:param` na raiz que a capture.
 */
export function createAdminEnquadreEventListRoutes(
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
  controller: EnquadreEventListController,
): Router {
  const router = Router();
  const staffOnly = authMiddleware.requireStaff();
  const perm = permissions.family(ADMIN_VACANCIES_FAMILY);

  router.get(
    '/enquadre-events',
    staffOnly,
    perm.require('enquadre_event', 'read'),
    perm.require('vacancy', 'read'),
    (req: Request, res: Response) => controller.listAll(req, res),
  );

  return router;
}
