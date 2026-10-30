import { Router, Request, Response } from 'express';
import type { AuthMiddleware, PermissionMiddleware } from '@modules/identity';
import { ADMIN_INTEGRATIONS_FAMILY } from '@modules/identity/permissions';
import { PedidoIaController } from '../controllers/PedidoIaController';

/**
 * /api/admin/pedidos-ia/* — a página de pedidos do Sol (spec 078, M3b-1). Células `pedidos_ia:read` (ver) e
 * `pedidos_ia:decidir` (aceitar/negar/descrever). Família `admin.integrations`, a mesma de `ai_prompt` (nenhuma família nova:
 * exigiria `ALL_PERMISSION_FAMILIES`). `untilEnforced: 'admin'`: enquanto a família não estiver enforced, cai no papel ADMIN.
 * `perm.require` sempre no ARRAY da rota, nunca em closure (memória `celula-em-closure-nao-entra-no-catalogo`).
 * O filtro por área é só parâmetro aqui; restringir pelo nível de acesso do gestor é da M6.
 */
export function createAdminPedidosIaRoutes(
  controller: PedidoIaController,
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
): Router {
  const router = Router();
  const staffOnly = authMiddleware.requireStaff();
  const perm = permissions.family(ADMIN_INTEGRATIONS_FAMILY);

  router.get('/pedidos-ia', staffOnly, perm.require('pedidos_ia', 'read', { untilEnforced: 'admin' }), (req: Request, res: Response) => controller.list(req, res));
  router.get('/pedidos-ia/:id', staffOnly, perm.require('pedidos_ia', 'read', { untilEnforced: 'admin' }), (req: Request, res: Response) => controller.get(req, res));
  router.post('/pedidos-ia/:id/aceitar', staffOnly, perm.require('pedidos_ia', 'decidir', { untilEnforced: 'admin' }), (req: Request, res: Response) => controller.aceitar(req, res));
  router.post('/pedidos-ia/:id/negar', staffOnly, perm.require('pedidos_ia', 'decidir', { untilEnforced: 'admin' }), (req: Request, res: Response) => controller.negar(req, res));
  router.post('/pedidos-ia/:id/descrever', staffOnly, perm.require('pedidos_ia', 'decidir', { untilEnforced: 'admin' }), (req: Request, res: Response) => controller.descrever(req, res));

  return router;
}
