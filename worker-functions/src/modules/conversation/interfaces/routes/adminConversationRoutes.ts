import { Router, Request, Response } from 'express';
import multer from 'multer';
import { AuthMiddleware, type PermissionMiddleware } from '@modules/identity';
import { ADMIN_PATIENTS_FAMILY } from '@modules/identity/permissions';
import { logResourceAccess } from '@shared/audit/resourceAccessLog';
import { withMulterErrorAsJson } from '@shared/http/withMulterErrorAsJson';
import { AdminConversationController } from '../controllers/AdminConversationController';
import { AdminConversationAttachmentController } from '../controllers/AdminConversationAttachmentController';
import { MAX_ATTACHMENT_BYTES } from '../../infrastructure/ConversationAttachmentPolicy';

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
 * Rotas de anexo (`.../files`, `.../files/:fileId/url` — spec 022, Bloco 3, T311/T312/T314/T315)
 * ENTRAM aqui, mesmo prefixo/família — controller PRÓPRIO (`AdminConversationAttachmentController`),
 * só a montagem do `Router` é compartilhada (mesmo padrão de `adminPatientPhotoRoutes.ts`, que
 * também vive fora do controller principal de paciente).
 */
const uploadAttachment = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ATTACHMENT_BYTES } });

export function createAdminConversationRoutes(
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
  controller: AdminConversationController = new AdminConversationController(),
  attachmentController: AdminConversationAttachmentController = new AdminConversationAttachmentController(),
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

  // ── Anexo (spec 022, Bloco 3, T311/T312/T314/T315) ───────────────────────────────────────────
  router.post(
    '/patients/:id/conversation/files',
    staffOnly,
    perm.require('patient_conversation', 'create'),
    withMulterErrorAsJson(uploadAttachment)('file'),
    (req: Request, res: Response) => attachmentController.upload(req, res),
  );

  router.get(
    '/patients/:id/conversation/files/:fileId/url',
    staffOnly,
    perm.require('patient_conversation', 'read'),
    logResourceAccess('patient', 'read_conversation_attachment'),
    (req: Request, res: Response) => attachmentController.getUrl(req, res),
  );

  return router;
}
