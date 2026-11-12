import { Router, Request, Response } from 'express';
import type { AuthMiddleware, PermissionMiddleware } from '@modules/identity';
import { ADMIN_INTEGRATIONS_FAMILY } from '@modules/identity/permissions';
import type { LuzPruebaController } from '../controllers/LuzPruebaController';

/**
 * POST /api/admin/luz-prueba/turn — Luz (prueba), spec 086. Célula `luz_prueba:chat` (SÓ o Acesso Master), família `admin.integrations`
 * (a mesma de `pedidos_ia`: nenhuma família nova). Ordem do array = contrato: `requireStaff` -> `perm.require` -> handler;
 * `perm.require` sempre no ARRAY, nunca em closure.
 */
export function createAdminLuzPruebaRoutes(
  controller: LuzPruebaController,
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
): Router {
  const router = Router();
  const staffOnly = authMiddleware.requireStaff();
  const perm = permissions.family(ADMIN_INTEGRATIONS_FAMILY);

  router.post('/luz-prueba/turn', staffOnly, perm.require('luz_prueba', 'chat', { untilEnforced: 'admin' }), (req: Request, res: Response) => controller.turn(req, res));

  return router;
}
