/**
 * registerAdminMaintenanceRoutes
 *
 * Monta rotas admin de manutenção: Dedup (Centro de Duplicados) + Test
 * Fixtures cleanup (teardown E2E + faxina geral de dado is_test).
 * Extraído de src/index.ts para respeitar o limite de 400 linhas.
 */

import type { Express } from 'express';
import type { AuthMiddleware } from '@modules/identity';
import { AdminDedupController } from '../interfaces/controllers/dedup/AdminDedupController';
import { createDedupRoutes } from '../interfaces/routes/dedupRoutes';
import { AdminTestFixturesController } from '../interfaces/controllers/testFixtures/AdminTestFixturesController';
import { createTestFixturesRoutes } from '../interfaces/routes/testFixturesRoutes';

export function registerAdminMaintenanceRoutes(app: Express, authMiddleware: AuthMiddleware): void {
  // ========== Admin Dedup (Centro de Duplicados) ==========
  const adminDedupController = new AdminDedupController();
  app.use('/api/admin/dedup', createDedupRoutes(adminDedupController, authMiddleware));

  // ========== Admin Test Fixtures (teardown E2E + faxina is_test) ==========
  const adminTestFixturesController = new AdminTestFixturesController();
  app.use('/api/admin/test-fixtures', createTestFixturesRoutes(adminTestFixturesController, authMiddleware));
}
