import { Router, Request, Response } from 'express';
import { AuthMiddleware } from '@modules/identity';
import { TemplateDraftsController } from '../controllers/TemplateDraftsController';

/**
 * Rotas do rascunho de mensagem (spec 010, F2 passos 2.1 e 2.2) — em /api/admin.
 *
 * Leitura: staff. Escrita: admin — precedente do parecer `lex` de 29/08,
 * condição C7 (quem configura ≠ quem dispara).
 *
 * 🔒 REGISTRO: a rota `/submit` escreve para FORA do perímetro (cria Content na
 * Twilio e submete à Meta) e o parecer do `lex` NÃO foi emitido. O Gabriel
 * determinou construir assim em 31/08/2026. A rota sobe DESLIGADA por
 * `TEMPLATE_SUBMISSION_ENABLED`, porque merge = deploy neste repo.
 *
 * ⚠️ `/submit` é a única rota irreversível do arquivo. Ela exige `confirmado:
 * true` no corpo, e o teste trava isso — sem a confirmação, 400.
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
  router.post('/template-drafts/:id/submit', authMiddleware.requireAdmin(), (req: Request, res: Response) => controller.submit(req, res));
  router.post('/template-drafts/:id/duplicate', authMiddleware.requireAdmin(), (req: Request, res: Response) => controller.duplicate(req, res));
  return router;
}
