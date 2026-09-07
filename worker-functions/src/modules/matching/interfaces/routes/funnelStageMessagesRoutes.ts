import { Router, Request, Response } from 'express';
import { AuthMiddleware, type PermissionMiddleware } from '@modules/identity';
import { ADMIN_MESSAGING_FAMILY } from '@modules/identity/permissions';
import { FunnelStageMessagesController } from '../controllers/FunnelStageMessagesController';

/**
 * Rotas da configuração "mensagem por etapa" (DEC-12) — montadas em /api/admin.
 * Leitura: staff. Escrita: SÓ admin (lex 29/08 C7 — quem configura ≠ quem dispara).
 */
export function createFunnelStageMessagesRoutes(
  controller: FunnelStageMessagesController,
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
): Router {
  const router = Router();
  // Célula declarada no sync main→stage (06/09/2026): sem ela o deny-when-undeclared do trem ABAC reprova o inventário.
  const perm = permissions.family(ADMIN_MESSAGING_FAMILY);
  router.get('/funnel-stage-messages', authMiddleware.requireStaff(), perm.require('messaging', 'read'), (req: Request, res: Response) => controller.list(req, res));
  router.put('/funnel-stage-messages/:stage', authMiddleware.requireStaff(), perm.require('messaging', 'write', { untilEnforced: 'admin' }), (req: Request, res: Response) => controller.update(req, res));
  return router;
}
