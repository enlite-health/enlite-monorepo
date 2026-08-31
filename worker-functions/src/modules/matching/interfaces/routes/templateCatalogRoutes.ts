import { Router, Request, Response } from 'express';
import { AuthMiddleware } from '@modules/identity';
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
): Router {
  const router = Router();
  router.get('/template-catalog', authMiddleware.requireStaff(), (req: Request, res: Response) => controller.list(req, res));
  return router;
}
