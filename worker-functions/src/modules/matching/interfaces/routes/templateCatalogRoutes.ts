import { Router, Request, Response } from 'express';
import { AuthMiddleware, type PermissionMiddleware } from '@modules/identity';
import { ADMIN_MESSAGING_FAMILY } from '@modules/identity/permissions';
import { TemplateCatalogController } from '../controllers/TemplateCatalogController';

/**
 * Rotas do catálogo de plantillas (spec 010, F1) — montadas em /api/admin.
 *
 * Só leitura, e só staff. NÃO acrescentar rota de escrita aqui sem parecer do
 * `lex`: criar/submeter template sai do nosso perímetro e vai para a Meta, o
 * que é ação outward-facing e irreversível. O teste desta rota assere 404 em
 * POST/PUT/PATCH/DELETE justamente para que a ausência seja verificada, e não
 * apenas pretendida.
 */
export function createTemplateCatalogRoutes(
  controller: TemplateCatalogController,
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
): Router {
  const router = Router();
  // Célula declarada no sync main→stage (06/09/2026): sem ela o deny-when-undeclared do trem ABAC reprova o inventário.
  const perm = permissions.family(ADMIN_MESSAGING_FAMILY);
  router.get('/template-catalog', authMiddleware.requireStaff(), perm.require('messaging', 'read'), (req: Request, res: Response) => controller.list(req, res));
  return router;
}
