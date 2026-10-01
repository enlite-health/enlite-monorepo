import { Router, Request, Response } from 'express';
import type { AuthMiddleware, PermissionMiddleware } from '@modules/identity';
import { ADMIN_USERS_FAMILY } from '@modules/identity/permissions';
import type { PermissionClient } from '@modules/identity/permissions';
import { AdminNotificationController } from '../controllers/AdminNotificationController';
import { GetNotificationsUseCase } from '../../application/GetNotificationsUseCase';
import { NotificationRepository } from '../../infrastructure/NotificationRepository';
import { PermissionClientActorAccessChecker } from '../../infrastructure/PermissionClientActorAccessChecker';

/**
 * Rotas de notificação in-app (spec 022, Bloco 4, T405; `contracts/openapi-notifications.md`).
 * Montadas sob `/api/admin`, molde `adminStaffDirectoryRoutes.ts` (mesma família `admin.users`,
 * F11/T007 — célula que não é 1:1 com recurso de paciente).
 *
 * Células declaradas AQUI, LITERAIS em cada rota — nunca por variável/loop/closure
 * (`celula-em-closure-nao-entra-no-catalogo`):
 *  - `own_notifications:read`   — GET lista, GET unread-count.
 *  - `own_notifications:update` — POST :id/read, POST read-all.
 *
 * `staffOnly` SEMPRE antes de `perm.require` — mesmo contrato de `adminConversationRoutes.ts`.
 *
 * `permissionClient` (opcional): quando fornecido, injeta `PermissionClientActorAccessChecker`
 * real no `GetNotificationsUseCase` (D-13, revisado no fecho B5: resolve `patientDisplayName`
 * sob a célula do DESTINATÁRIO da requisição, não do ator do evento). `src/index.ts` passa
 * `permissionsBoundary.permissions.client`; sem ele (ex.: testes que não precisam do nome do
 * paciente), `patientDisplayName` sai sempre `null` — nunca quebra.
 */
export function createAdminNotificationRoutes(
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
  permissionClient?: PermissionClient,
  controller: AdminNotificationController = new AdminNotificationController(
    new GetNotificationsUseCase(
      new NotificationRepository(),
      permissionClient ? new PermissionClientActorAccessChecker(permissionClient) : undefined,
    ),
  ),
): Router {
  const router = Router();
  const staffOnly = authMiddleware.requireStaff();
  const perm = permissions.family(ADMIN_USERS_FAMILY);

  router.get(
    '/notifications',
    staffOnly,
    perm.require('own_notifications', 'read'),
    (req: Request, res: Response) => controller.list(req, res),
  );

  router.get(
    '/notifications/unread-count',
    staffOnly,
    perm.require('own_notifications', 'read'),
    (req: Request, res: Response) => controller.unreadCount(req, res),
  );

  router.post(
    '/notifications/:id/read',
    staffOnly,
    perm.require('own_notifications', 'update'),
    (req: Request, res: Response) => controller.markRead(req, res),
  );

  router.post(
    '/notifications/read-all',
    staffOnly,
    perm.require('own_notifications', 'update'),
    (req: Request, res: Response) => controller.markAllRead(req, res),
  );

  return router;
}
