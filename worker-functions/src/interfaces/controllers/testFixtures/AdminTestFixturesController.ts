/**
 * AdminTestFixturesController
 *
 * Controller fino para o teardown de dado is_test (workers + job_postings +
 * filhos). Sem lógica de negócio — toda lógica vive em
 * src/application/testFixtures/CleanupTestFixturesUseCase.ts.
 *
 * Endpoints:
 *   POST /api/admin/test-fixtures/cleanup
 */

import type { Request, Response } from 'express';
import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { logger, reportError } from '@shared/logging';
import { CleanupTestFixturesUseCase } from '../../../application/testFixtures/CleanupTestFixturesUseCase';

const log = logger.child({ source: 'AdminTestFixturesController' });

export class AdminTestFixturesController {
  private readonly pool: Pool;

  constructor() {
    this.pool = DatabaseConnection.getInstance().getPool();
  }

  // POST /api/admin/test-fixtures/cleanup
  async cleanup(req: Request, res: Response): Promise<void> {
    try {
      const useCase = new CleanupTestFixturesUseCase(this.pool);
      const result = await useCase.execute();

      log.info({ msg: 'admin_test_fixtures_cleanup_via_endpoint', ...result.deleted });
      res.json({ success: true, data: result });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminTestFixturesController:cleanup' });
      res.status(500).json({ success: false, error: 'Erro interno' });
    }
  }
}
