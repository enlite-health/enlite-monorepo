/**
 * dedupRoutes
 *
 * Monta o router do Centro de Duplicados.
 * Todos os endpoints gated por requireAdmin().
 *
 * Montado em src/index.ts como:
 *   app.use('/api/admin/dedup', adminOnly, dedupRouter);
 *
 * ── Família `admin.dedup` (task 3.5-A5, a ÚLTIMA de propósito) ───────────────
 * 9 rotas, 2 células, ambas já no seed da 206. Mapa rota→célula:
 * `openspec/changes/painel-grupos-permissao/route-permission-map.md`.
 *
 * É a última da ordem do design 6 porque `dedup:execute` **funde cadastros de
 * pessoas**: `merge` reparenta telefone, e-mail e histórico de um worker para
 * outro. O `undo` existe (`/merges/:auditId/undo`) e por isso é `execute` e não
 * `delete` — mas desfazer depende de a trilha estar íntegra, então o custo de
 * errar aqui é o mais alto da task 3.5.
 *
 * ⚠️ A mesma célula `dedup:execute` também é exigida por
 * `POST /analytics/dedup/run`, que mora na família `admin.analytics` (A3, PR
 * #239). Célula é transversal; família é a unidade de rollout. Virar
 * `admin.dedup` NÃO alcança aquela rota, e vice-versa.
 *
 * ℹ️ O controller devolve telefone e nome. Isso é INERENTE à feature — deduplicar
 * é casar pessoas por telefone e nome —, não desalinhamento de célula: não existe
 * rota irmã com o mesmo payload sob célula mais forte (o teste da D127 passa).
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { AdminDedupController } from '../controllers/dedup/AdminDedupController';
import type { AuthMiddleware } from '../../modules/identity/interfaces/middleware/AuthMiddleware';
import type { PermissionMiddleware } from '../../modules/identity/interfaces/middleware/PermissionMiddleware';

export const ADMIN_DEDUP_FAMILY = 'admin.dedup';

export function createDedupRoutes(
  controller: AdminDedupController,
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
): Router {
  const router = Router();
  const adminOnly = authMiddleware.requireAdmin();
  const perm = permissions.family(ADMIN_DEDUP_FAMILY);

  // GET /api/admin/dedup/groups
  router.get('/groups', adminOnly, perm.require('dedup', 'read'), (req: Request, res: Response) =>
    controller.listGroups(req, res),
  );

  // GET /api/admin/dedup/groups/:phoneNormalized
  router.get('/groups/:phoneNormalized', adminOnly, perm.require('dedup', 'read'), (req: Request, res: Response) =>
    controller.getGroupDetail(req, res),
  );

  // POST /api/admin/dedup/merge
  router.post('/merge', adminOnly, perm.require('dedup', 'execute'), (req: Request, res: Response) =>
    controller.executeMerge(req, res),
  );

  // POST /api/admin/dedup/dismiss
  router.post('/dismiss', adminOnly, perm.require('dedup', 'execute'), (req: Request, res: Response) =>
    controller.dismissGroup(req, res),
  );

  // POST /api/admin/dedup/merges/:auditId/undo
  router.post('/merges/:auditId/undo', adminOnly, perm.require('dedup', 'execute'), (req: Request, res: Response) =>
    controller.undoMerge(req, res),
  );

  // GET /api/admin/dedup/history
  router.get('/history', adminOnly, perm.require('dedup', 'read'), (req: Request, res: Response) =>
    controller.listHistory(req, res),
  );

  // GET /api/admin/dedup/imported-groups
  router.get('/imported-groups', adminOnly, perm.require('dedup', 'read'), (req: Request, res: Response) =>
    controller.listImportedGroups(req, res),
  );

  // GET /api/admin/dedup/candidates?q=<text>&limit=<n>
  router.get('/candidates', adminOnly, perm.require('dedup', 'read'), (req: Request, res: Response) =>
    controller.searchCandidates(req, res),
  );

  // POST /api/admin/dedup/manual-group
  router.post('/manual-group', adminOnly, perm.require('dedup', 'execute'), (req: Request, res: Response) =>
    controller.buildManualGroup(req, res),
  );

  return router;
}
