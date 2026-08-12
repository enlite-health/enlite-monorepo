/**
 * testFixturesRoutes
 *
 * Monta o router de teardown de dado is_test (teste E2E + faxina geral).
 * Endpoint admin-only, gated por requireAdmin().
 *
 * Montado em src/index.ts como:
 *   app.use('/api/admin/test-fixtures', createTestFixturesRoutes(controller, authMiddleware));
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { AdminTestFixturesController } from '../controllers/testFixtures/AdminTestFixturesController';
import type { AuthMiddleware } from '../../modules/identity/interfaces/middleware/AuthMiddleware';

export function createTestFixturesRoutes(
  controller: AdminTestFixturesController,
  authMiddleware: AuthMiddleware,
): Router {
  const router = Router();
  const adminOnly = authMiddleware.requireAdmin();

  // POST /api/admin/test-fixtures/cleanup
  router.post('/cleanup', adminOnly, (req: Request, res: Response) =>
    controller.cleanup(req, res),
  );

  return router;
}
