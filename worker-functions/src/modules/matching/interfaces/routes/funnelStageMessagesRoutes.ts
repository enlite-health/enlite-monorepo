import { Router, Request, Response } from 'express';
import { AuthMiddleware } from '@modules/identity';
import { FunnelStageMessagesController } from '../controllers/FunnelStageMessagesController';

/**
 * Rotas da configuração "mensagem por etapa" (DEC-12) — montadas em /api/admin.
 * Leitura: staff. Escrita: SÓ admin (lex 29/08 C7 — quem configura ≠ quem dispara).
 */
export function createFunnelStageMessagesRoutes(
  controller: FunnelStageMessagesController,
  authMiddleware: AuthMiddleware,
): Router {
  const router = Router();
  router.get('/funnel-stage-messages', authMiddleware.requireStaff(), (req: Request, res: Response) => controller.list(req, res));
  router.put('/funnel-stage-messages/:stage', authMiddleware.requireAdmin(), (req: Request, res: Response) => controller.update(req, res));
  return router;
}
