import { Router, Request, Response } from 'express';
import multer from 'multer';
import { AuthMiddleware, type PermissionMiddleware } from '@modules/identity';
import { ADMIN_PATIENTS_FAMILY } from '@modules/identity/permissions';
import { logResourceAccess } from '@shared/audit/resourceAccessLog';
import { withMulterErrorAsJson } from '@shared/http/withMulterErrorAsJson';
import { MAX_ATTACHMENT_BYTES } from '@modules/conversation/infrastructure/ConversationAttachmentPolicy';
import { PatientDocumentsController } from '../controllers/PatientDocumentsController';

/**
 * Rotas da aba "Documentos" do paciente (spec 031, D463). Montadas sob `/api/admin`, família
 * `admin.patients`, molde `adminConversationRoutes.ts`.
 *
 * Células LITERAIS em cada rota (nunca por variável/loop/closure — o scanner do catálogo só
 * reconhece `perm.require('recurso', 'ação', ...)` com strings literais;
 * `celula-em-closure-nao-entra-no-catalogo`):
 *  - `patient_document:read`   — GET lista, GET url (trilha `logResourceAccess`, só UUID).
 *  - `patient_document:create` — POST (multipart `file` + `label`).
 *  - `patient_document:update` — PATCH (renomear).
 *  - `patient_document:delete` — DELETE (definitivo).
 * `untilEnforced: 'admin'`: com a família ainda não enforçada, só o papel admin passa (antes do flip).
 * `staffOnly` SEMPRE antes de `perm.require` (a ordem é parte do contrato do `PermissionMiddleware`).
 *
 * Mesma política de arquivo do chat (10 MB, PDF/PNG/JPEG/DOCX): o multer barra o tamanho (413) e o
 * validador do chat checa o tipo/conteúdo no use case (415).
 */
const uploadDocument = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ATTACHMENT_BYTES } });

export function createPatientDocumentsRoutes(
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
  controller: PatientDocumentsController = new PatientDocumentsController(),
): Router {
  const router = Router();
  const staffOnly = authMiddleware.requireStaff();
  const perm = permissions.family(ADMIN_PATIENTS_FAMILY);

  router.get(
    '/patients/:id/documents',
    staffOnly,
    perm.require('patient_document', 'read', { untilEnforced: 'admin' }),
    logResourceAccess('patient', 'list_patient_documents'),
    (req: Request, res: Response) => controller.list(req, res),
  );

  router.post(
    '/patients/:id/documents',
    staffOnly,
    perm.require('patient_document', 'create', { untilEnforced: 'admin' }),
    withMulterErrorAsJson(uploadDocument)('file'),
    (req: Request, res: Response) => controller.upload(req, res),
  );

  router.patch(
    '/patients/:id/documents/:docId',
    staffOnly,
    perm.require('patient_document', 'update', { untilEnforced: 'admin' }),
    (req: Request, res: Response) => controller.rename(req, res),
  );

  router.delete(
    '/patients/:id/documents/:docId',
    staffOnly,
    perm.require('patient_document', 'delete', { untilEnforced: 'admin' }),
    (req: Request, res: Response) => controller.remove(req, res),
  );

  router.get(
    '/patients/:id/documents/:docId/url',
    staffOnly,
    perm.require('patient_document', 'read', { untilEnforced: 'admin' }),
    logResourceAccess('patient', (req) => `read_patient_document:${req.params.docId}`),
    (req: Request, res: Response) => controller.getUrl(req, res),
  );

  return router;
}
