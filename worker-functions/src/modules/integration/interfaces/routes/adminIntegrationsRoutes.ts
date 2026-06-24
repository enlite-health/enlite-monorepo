/**
 * adminIntegrationsRoutes — /api/admin/integrations/*
 *
 * Monta as rotas de integração administrativa. Todas requerem admin.
 * Chamado em src/index.ts: app.use('/api/admin', createAdminIntegrationsRoutes(authMiddleware))
 */

import { Router, Request, Response } from 'express';
import { AnaCareBackfillController } from '../controllers/AnaCareBackfillController';
import type { AuthMiddleware } from '@modules/identity';

export function createAdminIntegrationsRoutes(
  authMiddleware: AuthMiddleware,
): Router {
  const router = Router();
  const backfillController = new AnaCareBackfillController();

  /**
   * POST /api/admin/integrations/anacare/backfill
   *
   * Corpo JSON (tudo opcional):
   *   { dryRun?: boolean, limit?: number }
   *
   * dryRun padrão = true (não faz rede, só conta elegíveis).
   * Para sincronizar de verdade: { "dryRun": false }.
   *
   * Requer admin.
   */
  router.post(
    '/integrations/anacare/backfill',
    authMiddleware.requireAdmin(),
    (req: Request, res: Response) => backfillController.handle(req, res),
  );

  return router;
}
