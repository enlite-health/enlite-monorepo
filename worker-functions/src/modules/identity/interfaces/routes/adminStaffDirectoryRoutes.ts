import { Router, Request, Response } from 'express';
import type { AuthMiddleware } from '../middleware/AuthMiddleware';
import type { PermissionMiddleware } from '../middleware/PermissionMiddleware';
import { ADMIN_USERS_FAMILY } from '@modules/identity/permissions';
import { AdminStaffDirectoryController } from '../controllers/AdminStaffDirectoryController';

/**
 * Rota do diretório de staff (spec 022, T127/T128; `contracts/openapi-staff-directory.md`).
 * Molde: `adminConversationRoutes.ts`. Montada sob `/api/admin`.
 *
 * Família `admin.users` (F11/T007, `fatos-medidos.md`) — mesma família de
 * `adminUsersRoutes.ts`, decidida por ser agrupamento TEMÁTICO de rotas
 * (`user_management`), não 1:1 com recurso.
 *
 * Célula `staff_directory:read` — NOVA, concedida a TODO grupo de staff
 * (D-06 do contrato). LITERAL aqui, nunca por variável/loop/closure
 * (`celula-em-closure-nao-entra-no-catalogo`).
 *
 * `staffOnly` SEMPRE antes de `perm.require` — mesma ordem que
 * `adminConversationRoutes.ts` documenta como parte do contrato do
 * `PermissionMiddleware`.
 */
export function createAdminStaffDirectoryRoutes(
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
  controller: AdminStaffDirectoryController = new AdminStaffDirectoryController(),
): Router {
  const router = Router();
  const staffOnly = authMiddleware.requireStaff();
  const perm = permissions.family(ADMIN_USERS_FAMILY);

  router.get(
    '/staff-directory',
    staffOnly,
    perm.require('staff_directory', 'read'),
    (req: Request, res: Response) => controller.search(req, res),
  );

  return router;
}
