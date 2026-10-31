import { Router, Request, Response } from 'express';
import type { AuthMiddleware, PermissionMiddleware } from '@modules/identity';
import { ADMIN_INTEGRATIONS_FAMILY } from '@modules/identity/permissions';
import { exemptHandler } from '../../../identity/permissions/infrastructure/catalog/permissionMetadata';
import { requireServicoAssistentes } from '../middleware/requireServicoAssistentes';
import { AssistentesPlataformaController } from '../controllers/AssistentesPlataformaController';

/**
 * /api/admin/assistentes/alcance, /api/admin/agentes/placar, /api/admin/agentes/reportes — spec 080, contrato
 * `rotas-plataforma-novas.md` §1-§3. DUAS identidades em todas: serviço (`X-Enlite-Servico`) -> pessoa (`requireStaff`)
 * -> célula. Ordem do array é contrato; `perm.require` sempre no ARRAY, nunca em closure.
 * O alcance não pede célula (descreve o próprio ator: `req.permissionCells` só nasce dentro do `perm.require`).
 */
export function createAdminAssistentesRoutes(
  controller: AssistentesPlataformaController,
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
): Router {
  const router = Router();
  const staffOnly = authMiddleware.requireStaff();
  const perm = permissions.family(ADMIN_INTEGRATIONS_FAMILY);

  router.get('/assistentes/alcance', requireServicoAssistentes(), staffOnly, exemptHandler('self: descreve o próprio ator para o serviço das gestoras; requireStaff é o portão'), (req: Request, res: Response) => controller.alcance(req, res));
  router.get('/agentes/placar', requireServicoAssistentes(), staffOnly, perm.require('agentes_placar', 'read', { untilEnforced: 'admin' }), (req: Request, res: Response) => controller.placar(req, res));
  router.post('/agentes/reportes', requireServicoAssistentes(), staffOnly, perm.require('agentes_reporte', 'registrar', { untilEnforced: 'admin' }), (req: Request, res: Response) => controller.reportar(req, res));

  return router;
}
