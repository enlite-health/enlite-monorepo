import { Router, Request, Response } from 'express';
import { AuthMiddleware, type PermissionMiddleware } from '@modules/identity';
import { ADMIN_MESSAGING_FAMILY } from '@modules/identity/permissions';
import { TemplateDraftsController } from '../controllers/TemplateDraftsController';

/**
 * Rotas do rascunho de mensagem (spec 010, F2 passos 2.1 e 2.2) — em /api/admin.
 *
 * 🔒 TUDO exige ADMIN, inclusive a leitura — decisão do Gabriel em 01/09/2026:
 * "apenas admins podem ter acesso a essa funcionalidade". O menu já filtrava por
 * `isAdmin`, mas a rota de leitura aceitava staff: quem não via o item ainda
 * podia chamar a API direto. Menu não é controle de acesso; rota é.
 *
 * Mantém o precedente do parecer `lex` de 29/08, condição C7 (quem configura ≠
 * quem dispara) — aqui ele fica mais estrito, não menos.
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
  permissions: PermissionMiddleware,
): Router {
  const router = Router();
  // Célula declarada no sync main→stage (06/09/2026): sem ela o deny-when-undeclared do trem ABAC reprova o inventário.
  const perm = permissions.family(ADMIN_MESSAGING_FAMILY);
  router.get('/template-drafts', authMiddleware.requireAdmin(), perm.require('messaging', 'read'), (req: Request, res: Response) => controller.list(req, res));
  router.post('/template-drafts', authMiddleware.requireAdmin(), perm.require('messaging', 'write'), (req: Request, res: Response) => controller.create(req, res));
  /*
   * 🔒 `/validar` NÃO GRAVA NADA, e existe por uma razão de arquitetura, não de
   * conveniência. O desenho da Tela 2 pede uma lista de verificação AO VIVO —
   * "Antes de enviar a Meta", 8 itens que reagem enquanto a pessoa escreve.
   *
   * A tentação seria reimplementar as regras no frontend para ter isso sem ida
   * ao servidor. Está escrito em `templateDraftsView.ts`, com todas as letras,
   * por que não: "reimplementá-las aqui criaria duas verdades que divergem no
   * primeiro ajuste — e a que a pessoa vê não seria a que decide".
   *
   * Esta rota é a saída: ela roda `validarRascunho`, A MESMA função que o
   * `create` e o `submit` rodam. A lista fica viva e continua havendo uma
   * verdade só. Se as regras mudarem, mudam nos três lugares de uma vez porque
   * são o mesmo lugar.
   */
  router.post('/template-drafts/validar', authMiddleware.requireAdmin(), perm.require('messaging', 'write'), (req: Request, res: Response) => controller.validar(req, res));
  router.put('/template-drafts/:id', authMiddleware.requireAdmin(), perm.require('messaging', 'write'), (req: Request, res: Response) => controller.update(req, res));
  router.delete('/template-drafts/:id', authMiddleware.requireAdmin(), perm.require('messaging', 'write'), (req: Request, res: Response) => controller.archive(req, res));
  router.post('/template-drafts/:id/submit', authMiddleware.requireAdmin(), perm.require('messaging', 'write'), (req: Request, res: Response) => controller.submit(req, res));
  router.post('/template-drafts/:id/duplicate', authMiddleware.requireAdmin(), perm.require('messaging', 'write'), (req: Request, res: Response) => controller.duplicate(req, res));
  return router;
}
