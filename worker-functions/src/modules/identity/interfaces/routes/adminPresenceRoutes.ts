import { Router, Request, Response } from 'express';
import type { AuthMiddleware } from '../middleware/AuthMiddleware';
import type { PermissionMiddleware } from '../middleware/PermissionMiddleware';
import { ADMIN_USERS_FAMILY } from '@modules/identity/permissions';
import { AdminPresenceController } from '../controllers/AdminPresenceController';

/**
 * Rota de presença (heartbeat) — change 022-ux-mencao-e-notificacao, Rodada 2/R2-B.
 * Montada sob `/api/admin`. Molde: `adminNotificationRoutes.ts` — mesma família `admin.users`,
 * mesma CLASSE de célula "own_*": o próprio staff sempre pode operar o PRÓPRIO estado, nasce
 * concedida a TODO grupo ativo (`migrations/466_grant_own_presence_all_staff.sql`, mesma regra de
 * D-07/`own_notifications`), nunca 0 grupos como `patient_conversation`/`staff_directory`.
 *
 * Célula `own_presence:update` — LITERAL aqui, nunca por variável/loop/closure
 * (`celula-em-closure-nao-entra-no-catalogo`).
 *
 * `staffOnly` SEMPRE antes de `perm.require` — mesmo contrato das rotas vizinhas.
 */
export function createAdminPresenceRoutes(
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
  controller: AdminPresenceController = new AdminPresenceController(),
): Router {
  const router = Router();
  const staffOnly = authMiddleware.requireStaff();
  const perm = permissions.family(ADMIN_USERS_FAMILY);

  router.post(
    '/me/presence',
    staffOnly,
    perm.require('own_presence', 'update'),
    (req: Request, res: Response) => controller.heartbeat(req, res),
  );

  return router;
}
