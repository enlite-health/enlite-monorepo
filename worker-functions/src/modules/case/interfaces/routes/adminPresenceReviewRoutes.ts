import { Router, Request, Response } from 'express';
import { AuthMiddleware, type PermissionMiddleware } from '@modules/identity';
import { ADMIN_PATIENTS_FAMILY } from '@modules/identity/permissions';
import { PresenceReviewController } from '../controllers/PresenceReviewController';

/**
 * Fila de revisão de presença da coordenação (emenda 077 §6), na família `admin.patients` (nenhuma família nova). Célula LITERAL `presence_exception:review`
 * nas DUAS rotas (leitura e decisão), no ARRAY — nunca em closure, senão o scanner do catálogo não a vê e ela nunca entra em `iam.permissions`.
 *
 * Acesso Master: o `perm.require` não aceita alternativa (`|| is_master_member`), e não precisa — a sincronização do catálogo concede TODA célula ativa
 * ao Acesso Master (D338, `iam.grant_active_permissions_to_master`), então o Master a recebe no boot que declara a célula. Dar a célula a outro grupo
 * é ato da operação. `untilEnforced: 'admin'`: enquanto a família não é enforçada, só o papel admin passa (nunca "todo staff vê nome e caso").
 */
export function createAdminPresenceReviewRoutes(
  controller: PresenceReviewController,
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
): Router {
  const router = Router();
  const staffOnly = authMiddleware.requireStaff();
  const perm = permissions.family(ADMIN_PATIENTS_FAMILY);

  router.get('/presence/review-queue', staffOnly, perm.require('presence_exception', 'review', { untilEnforced: 'admin' }), (req: Request, res: Response) => controller.queue(req, res));
  router.post('/presence/exceptions/:eventId/decision', staffOnly, perm.require('presence_exception', 'review', { untilEnforced: 'admin' }), (req: Request, res: Response) => controller.decide(req, res));

  return router;
}
