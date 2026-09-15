import { Router, Request, Response } from 'express';
import { EncuadreController } from '../controllers/EncuadreController';
import { AuthMiddleware, type PermissionMiddleware } from '@modules/identity';

/**
 * Worker status & encuadre routes — /api/workers/* and /api/cases/*
 *
 * Staff-only: são dashboards de operação, escrita de status de funil e leituras
 * cross-worker por :id — nada aqui é "o worker sobre si mesmo" (isso vive em
 * /api/workers/me/*). Com requireAuth() genérico, qualquer worker autenticado
 * alcançava tecnicamente escrita de funil de terceiros.
 *
 * ── Família `admin.encuadre` (task 3.5-A6, a ÚLTIMA a declarar) ─────────────
 * 10 rotas, 5 células, todas já no seed da 206. Mapa rota→célula:
 * `openspec/changes/painel-grupos-permissao/route-permission-map.md`.
 *
 * ⚠️ ESTAS SÃO AS 10 ROTAS QUE O PERÍMETRO NÃO ALCANÇAVA. `GOVERNED_PREFIXES` é
 * `/api/admin/` + `/analytics/`, e elas moram em `/api/workers/` e `/api/cases/`
 * — eram `not_governed`, invisíveis ao deny-by-default, ao `PENDING_DECLARATIONS`
 * e ao oráculo de rotas. Entraram no perímetro por NOME em 19/08 (`GOVERNED_ROUTES`,
 * PR #237) e agora declaram célula como qualquer outra.
 *
 * ⚠️ FAMÍLIA PRÓPRIA, e não `admin.workers` — desvio deliberado da recomendação
 * do plano, decidido em 20/08. Elas reusam as células de `admin.workers`, e
 * dobrá-las naquela família faria com que, na PRIMEIRA vez que fossem enforçadas
 * na vida, fossem enforçadas junto com outras 31 rotas. São a parte da superfície
 * menos exercitada (ninguém sequer sabia que estavam fora do perímetro até
 * ontem): virar sozinhas, depois de `admin.workers` já ter provado estabilidade,
 * é exatamente o isolamento de risco para o qual a família existe. Célula é
 * transversal, família é unidade de rollout — a distinção provada no A5.
 */
import { ADMIN_ENCUADRE_FAMILY } from '@modules/identity/permissions';
export { ADMIN_ENCUADRE_FAMILY };

export function createWorkerEncuadreRoutes(
  encuadreController: EncuadreController,
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
): Router {
  const router = Router();
  const auth = authMiddleware.requireStaff();
  const perm = permissions.family(ADMIN_ENCUADRE_FAMILY);

  router.get('/workers/status-dashboard', auth, perm.require('worker', 'read'), (req: Request, res: Response) =>
    encuadreController.getStatusDashboard(req, res),
  );
  router.get('/workers/by-status/:status', auth, perm.require('worker', 'read'), (req: Request, res: Response) =>
    encuadreController.getWorkersByStatus(req, res),
  );
  router.put('/workers/:id/status', auth, perm.require('worker', 'update'), (req: Request, res: Response) =>
    encuadreController.updateWorkerStatus(req, res),
  );
  router.put('/workers/:id/occupation', auth, perm.require('worker', 'update'), (req: Request, res: Response) =>
    encuadreController.updateOccupation(req, res),
  );
  router.get('/workers/docs-expiring', auth, perm.require('worker_document', 'read'), (req: Request, res: Response) =>
    encuadreController.getDocsExpiringSoon(req, res),
  );
  router.put('/workers/:id/doc-expiry', auth, perm.require('worker_document', 'update'), (req: Request, res: Response) =>
    encuadreController.updateDocExpiry(req, res),
  );
  router.get('/workers/:id/encuadres', auth, perm.require('match', 'read'), (req: Request, res: Response) =>
    encuadreController.getWorkerEncuadres(req, res),
  );
  router.get('/workers/:id/cases', auth, perm.require('match', 'read'), (req: Request, res: Response) =>
    encuadreController.getWorkerCases(req, res),
  );
  router.get('/cases/:caseNumber/encuadres', auth, perm.require('match', 'read'), (req: Request, res: Response) =>
    encuadreController.getCaseEncuadres(req, res),
  );
  router.get('/cases/:caseNumber/workers', auth, perm.require('match', 'read'), (req: Request, res: Response) =>
    encuadreController.getCaseWorkers(req, res),
  );

  return router;
}
