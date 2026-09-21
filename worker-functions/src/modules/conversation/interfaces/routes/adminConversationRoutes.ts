import { Router, Request, Response } from 'express';
import { AuthMiddleware, type PermissionMiddleware } from '@modules/identity';
import { ADMIN_PATIENTS_FAMILY } from '@modules/identity/permissions';
import { AdminConversationController } from '../controllers/AdminConversationController';

/**
 * Rotas de conversa do paciente (spec 022, Bloco 1, T119; `contracts/openapi-conversation.md`).
 * Montadas sob `/api/admin`, molde `adminPatientPhotoRoutes.ts`.
 *
 * Células declaradas AQUI, LITERAIS em cada rota — nunca por variável/loop/closure
 * (`celula-em-closure-nao-entra-no-catalogo`; o scanner do catálogo só reconhece
 * `perm.require('recurso', 'ação')` com strings literais):
 *  - `patient_conversation:read`   — GET conversa, GET replies, PUT read-mark.
 *  - `patient_conversation:create` — POST mensagem.
 *  - `patient_conversation:update` — PATCH mensagem.
 *  - `patient_conversation:delete` — DELETE mensagem.
 *
 * `staffOnly` SEMPRE antes de `perm.require` na cadeia — ordem é parte do contrato do
 * `PermissionMiddleware` (achado já visto: com a ordem trocada `denyUndeclaredRoutes` barraria a
 * rota mesmo com a célula declarada).
 *
 * As rotas de anexo (`.../files`, `.../files/:fileId/url`) do mesmo contrato NÃO entram aqui —
 * anexo é Bloco 3 (fora do escopo do fecho do B1); ficam para a task que as backear.
 */
export function createAdminConversationRoutes(
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
  controller: AdminConversationController = new AdminConversationController(),
): Router {
  const router = Router();
  const staffOnly = authMiddleware.requireStaff();
  const perm = permissions.family(ADMIN_PATIENTS_FAMILY);

  router.get(
    '/patients/:id/conversation',
    staffOnly,
    perm.require('patient_conversation', 'read'),
    (req: Request, res: Response) => controller.list(req, res),
  );

  router.get(
    '/patients/:id/conversation/messages/:mid/replies',
    staffOnly,
    perm.require('patient_conversation', 'read'),
    (req: Request, res: Response) => controller.listReplies(req, res),
  );

  router.post(
    '/patients/:id/conversation/messages',
    staffOnly,
    perm.require('patient_conversation', 'create'),
    (req: Request, res: Response) => controller.postMessage(req, res),
  );

  router.patch(
    '/patients/:id/conversation/messages/:mid',
    staffOnly,
    perm.require('patient_conversation', 'update'),
    (req: Request, res: Response) => controller.editMessage(req, res),
  );

  router.delete(
    '/patients/:id/conversation/messages/:mid',
    staffOnly,
    perm.require('patient_conversation', 'delete'),
    (req: Request, res: Response) => controller.deleteMessage(req, res),
  );

  router.put(
    '/patients/:id/conversation/read-mark',
    staffOnly,
    perm.require('patient_conversation', 'read'),
    (req: Request, res: Response) => controller.markRead(req, res),
  );

  return router;
}
