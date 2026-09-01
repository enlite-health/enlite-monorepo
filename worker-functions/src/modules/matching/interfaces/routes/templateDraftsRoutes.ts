import { Router, Request, Response } from 'express';
import { AuthMiddleware } from '@modules/identity';
import { TemplateDraftsController } from '../controllers/TemplateDraftsController';

/**
 * Rotas do rascunho de mensagem (spec 010, F2 passos 2.1 e 2.2) — em /api/admin.
 *
 * Leitura: staff. Escrita: admin — precedente do parecer `lex` de 29/08,
 * condição C7 (quem configura ≠ quem dispara).
 *
 * 🔒 NÃO existe rota de submissão, e a ausência é deliberada: submeter à Meta é
 * ato para fora do perímetro (F2 2.4) e depende de parecer do `lex` que ainda
 * não foi emitido. O teste desta rota assere 404 em
 * `POST /template-drafts/:id/submit` para que a ausência seja VERIFICADA e não
 * apenas pretendida — do mesmo jeito que o catálogo trava a escrita.
 */
export function createTemplateDraftsRoutes(
  controller: TemplateDraftsController,
  authMiddleware: AuthMiddleware,
): Router {
  const router = Router();
  router.get('/template-drafts', authMiddleware.requireStaff(), (req: Request, res: Response) => controller.list(req, res));
  router.post('/template-drafts', authMiddleware.requireAdmin(), (req: Request, res: Response) => controller.create(req, res));
  router.put('/template-drafts/:id', authMiddleware.requireAdmin(), (req: Request, res: Response) => controller.update(req, res));
  router.delete('/template-drafts/:id', authMiddleware.requireAdmin(), (req: Request, res: Response) => controller.archive(req, res));
  return router;
}
