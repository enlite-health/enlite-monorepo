/**
 * presentationInviteRoutes — REQ-09. Montado em src/index.ts sob /api/admin.
 * Leitura e clique: staff. Configuração: admin (auditada).
 */
import { Router } from 'express';
import type { AuthMiddleware } from '@modules/identity';
import { PresentationInviteController } from '../controllers/PresentationInviteController';

export function createPresentationInviteRoutes(controller: PresentationInviteController, authMiddleware: AuthMiddleware): Router {
  const router = Router();
  router.get('/presentation-invite/settings', authMiddleware.requireStaff(), controller.getSettings);
  router.put('/presentation-invite/settings', authMiddleware.requireAdmin(), controller.updateSettings);
  router.get('/presentation-invite/last', authMiddleware.requireStaff(), controller.last);
  router.get('/presentation-invite/stats', authMiddleware.requireStaff(), controller.stats);
  router.post('/workers/:workerId/presentation-invite', authMiddleware.requireStaff(), controller.invite);
  return router;
}
