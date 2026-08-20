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
import type { PermissionMiddleware } from '../../modules/identity/interfaces/middleware/PermissionMiddleware';

/**
 * ── Família `admin.test_fixtures` (task 3.5-A4) ─────────────────────────────
 * Uma rota, uma célula: **`test_fixtures:execute`** (D116). Célula NOVA, fora do
 * seed da 206. A rota APAGA dado marcado `is_test` — `execute` é ação sensível
 * (D-P4), então o ALLOW vai para a trilha junto com a negativa.
 */
export const ADMIN_TEST_FIXTURES_FAMILY = 'admin.test_fixtures';

export function createTestFixturesRoutes(
  controller: AdminTestFixturesController,
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
): Router {
  const router = Router();
  const adminOnly = authMiddleware.requireAdmin();
  const perm = permissions.family(ADMIN_TEST_FIXTURES_FAMILY);

  // POST /api/admin/test-fixtures/cleanup
  router.post('/cleanup', adminOnly, perm.require('test_fixtures', 'execute'), (req: Request, res: Response) =>
    controller.cleanup(req, res),
  );

  return router;
}
