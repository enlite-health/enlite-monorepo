/**
 * presentationInviteRoutes — REQ-09. Montado em src/index.ts sob /api/admin.
 * Leitura e clique: staff. Configuração: admin (auditada).
 */
import { Router } from 'express';
import type { AuthMiddleware, PermissionMiddleware } from '@modules/identity';
import { ADMIN_MESSAGING_FAMILY } from '@modules/identity/permissions';
import { PresentationInviteController } from '../controllers/PresentationInviteController';

export function createPresentationInviteRoutes(
  controller: PresentationInviteController,
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
): Router {
  const router = Router();
  // Célula declarada no sync main→stage (06/09/2026): sem ela o deny-when-undeclared do trem ABAC reprova o inventário.
  const perm = permissions.family(ADMIN_MESSAGING_FAMILY);
  router.get('/presentation-invite/settings', authMiddleware.requireStaff(), perm.require('messaging', 'read'), controller.getSettings);
  router.put('/presentation-invite/settings', authMiddleware.requireStaff(), perm.require('messaging', 'write', { untilEnforced: 'admin' }), controller.updateSettings);
  router.get('/presentation-invite/last', authMiddleware.requireStaff(), perm.require('messaging', 'read'), controller.last);
  router.get('/presentation-invite/stats', authMiddleware.requireStaff(), perm.require('messaging', 'read'), controller.stats);
  router.post('/workers/:workerId/presentation-invite', authMiddleware.requireStaff(), perm.require('messaging', 'send'), controller.invite);
  return router;
}
