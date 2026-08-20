/**
 * adminIntegrationsRoutes — /api/admin/integrations/*
 *
 * Monta as rotas de integração administrativa. Todas requerem admin.
 * Chamado em src/index.ts: app.use('/api/admin', createAdminIntegrationsRoutes(authMiddleware))
 */

import { Router, Request, Response } from 'express';
import { AnaCareBackfillController } from '../controllers/AnaCareBackfillController';
import type { AuthMiddleware, PermissionMiddleware } from '@modules/identity';

/**
 * ── Família `admin.integrations` (task 3.5-A4) ──────────────────────────────
 * Uma rota, uma célula: **`integration:execute`** (D116). É célula NOVA, fora do
 * seed da 206 — nasce quando o A7 ligar `PERMISSION_CATALOG_SYNC_ENABLED`.
 * `execute` e não `write`: o backfill não grava aqui, ele DISPARA sincronização
 * contra um sistema de terceiro (Ana Care), e `execute` é ação sensível (D-P4),
 * então o ALLOW também vai para a trilha.
 */
export const ADMIN_INTEGRATIONS_FAMILY = 'admin.integrations';

export function createAdminIntegrationsRoutes(
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
): Router {
  const router = Router();
  const backfillController = new AnaCareBackfillController();
  const perm = permissions.family(ADMIN_INTEGRATIONS_FAMILY);

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
    perm.require('integration', 'execute'),
    (req: Request, res: Response) => backfillController.handle(req, res),
  );

  return router;
}
