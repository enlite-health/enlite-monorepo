/**
 * dedupRoutes
 *
 * Monta o router do Centro de Duplicados.
 * Todos os endpoints gated por requireAdmin().
 *
 * Montado em src/index.ts como:
 *   app.use('/api/admin/dedup', adminOnly, dedupRouter);
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { AdminDedupController } from '../controllers/dedup/AdminDedupController';
import type { AuthMiddleware } from '../../modules/identity/interfaces/middleware/AuthMiddleware';

export function createDedupRoutes(
  controller: AdminDedupController,
  authMiddleware: AuthMiddleware,
): Router {
  const router = Router();
  const adminOnly = authMiddleware.requireAdmin();

  // GET /api/admin/dedup/groups
  router.get('/groups', adminOnly, (req: Request, res: Response) =>
    controller.listGroups(req, res),
  );

  // GET /api/admin/dedup/groups/:phoneNormalized
  router.get('/groups/:phoneNormalized', adminOnly, (req: Request, res: Response) =>
    controller.getGroupDetail(req, res),
  );

  // POST /api/admin/dedup/merge
  router.post('/merge', adminOnly, (req: Request, res: Response) =>
    controller.executeMerge(req, res),
  );

  // POST /api/admin/dedup/dismiss
  router.post('/dismiss', adminOnly, (req: Request, res: Response) =>
    controller.dismissGroup(req, res),
  );

  // POST /api/admin/dedup/merges/:auditId/undo
  router.post('/merges/:auditId/undo', adminOnly, (req: Request, res: Response) =>
    controller.undoMerge(req, res),
  );

  // GET /api/admin/dedup/history
  router.get('/history', adminOnly, (req: Request, res: Response) =>
    controller.listHistory(req, res),
  );

  return router;
}
