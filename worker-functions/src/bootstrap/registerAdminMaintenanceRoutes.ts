/**
 * registerAdminMaintenanceRoutes
 *
 * Monta rotas admin de manutenção: Dedup (Centro de Duplicados) + Test
 * Fixtures cleanup (teardown E2E + faxina geral de dado is_test).
 * Extraído de src/index.ts para respeitar o limite de 400 linhas.
 *
 * ⚠️ Monta DUAS famílias da task 3.5, ambas declaradas: `admin.test_fixtures`
 * (A4) e `admin.dedup` (A5). As duas usam o mesmo `permissions`.
 */

import type { Express } from 'express';
import type { AuthMiddleware, PermissionMiddleware } from '@modules/identity';
import { AdminDedupController } from '../interfaces/controllers/dedup/AdminDedupController';
import { createDedupRoutes } from '../interfaces/routes/dedupRoutes';
import { AdminTestFixturesController } from '../interfaces/controllers/testFixtures/AdminTestFixturesController';
import { createTestFixturesRoutes } from '../interfaces/routes/testFixturesRoutes';

export function registerAdminMaintenanceRoutes(
  app: Express,
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
): void {
  // ========== Admin Dedup (Centro de Duplicados) ==========
  const adminDedupController = new AdminDedupController();
  app.use('/api/admin/dedup', createDedupRoutes(adminDedupController, authMiddleware, permissions));

  // ========== Admin Test Fixtures (teardown E2E + faxina is_test) ==========
  const adminTestFixturesController = new AdminTestFixturesController();
  app.use('/api/admin/test-fixtures', createTestFixturesRoutes(adminTestFixturesController, authMiddleware, permissions));
}
