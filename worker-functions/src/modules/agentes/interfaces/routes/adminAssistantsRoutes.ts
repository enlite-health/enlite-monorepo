import { Router, Request, Response } from 'express';
import type { AuthMiddleware, PermissionMiddleware } from '@modules/identity';
import { ADMIN_INTEGRATIONS_FAMILY } from '@modules/identity/permissions';
import { exemptHandler } from '../../../identity/permissions/infrastructure/catalog/permissionMetadata';
import { requireAssistantsService } from '../middleware/requireAssistantsService';
import { AssistantsPlatformController } from '../controllers/AssistantsPlatformController';

/**
 * /api/admin/assistants/reach, /api/admin/assistants/scoreboard, /api/admin/assistants/escalations — spec 080, contract
 * `rotas-plataforma-novas.md` §1-§3. TWO identities on all of them: service (`X-Enlite-Service`) -> person (`requireStaff`)
 * -> cell. The array order is the contract; `perm.require` always in the ARRAY, never in a closure.
 * Reach asks for no cell (it describes the actor itself: `req.permissionCells` only exists inside `perm.require`).
 */
export function createAdminAssistantsRoutes(
  controller: AssistantsPlatformController,
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
): Router {
  const router = Router();
  const staffOnly = authMiddleware.requireStaff();
  const perm = permissions.family(ADMIN_INTEGRATIONS_FAMILY);

  router.get('/assistants/reach', requireAssistantsService(), staffOnly, exemptHandler('self: describes the actor itself for the assistants service; requireStaff is the gate'), (req: Request, res: Response) => controller.reach(req, res));
  router.get('/assistants/scoreboard', requireAssistantsService(), staffOnly, perm.require('assistant_scoreboard', 'read', { untilEnforced: 'admin' }), (req: Request, res: Response) => controller.scoreboard(req, res));
  router.post('/assistants/escalations', requireAssistantsService(), staffOnly, perm.require('assistant_escalation', 'register', { untilEnforced: 'admin' }), (req: Request, res: Response) => controller.escalate(req, res));

  return router;
}
