import { Router, Request, Response } from 'express';
import { WorkerDocumentsMeController } from '../controllers/WorkerDocumentsMeController';
import { WorkerAdditionalDocsMeController } from '../controllers/WorkerAdditionalDocsMeController';
import { AdminAdditionalDocsController } from '../controllers/AdminAdditionalDocsController';
import { AuthMiddleware, type PermissionMiddleware } from '@modules/identity';
import { ADMIN_WORKERS_FAMILY } from './adminWorkerRoutes';

/**
 * Worker document routes — both self-service (/api/workers/me/documents)
 * and admin additional docs (/api/admin/workers/:id/additional-documents).
 *
 * ⚠️ Este arquivo tem os DOIS lados, e só um deles é decisão de staff. As 9
 * rotas `/workers/me/*` são do PRÓPRIO prestador sobre os PRÓPRIOS documentos:
 * não declaram célula e não entram na família — quem as recorta é o `requireAuth`
 * + o dono do dado, não a matriz de permissão do time. Célula ali negaria o app
 * do candidato inteiro no dia da virada (é o mesmo motivo do desvio de não-staff
 * do `GroupPermissionEngine`, D119.1a).
 *
 * As 4 rotas `/admin/workers/:id/additional-documents*` são da família
 * `admin.workers` (task 3.5).
 */
export function createWorkerDocumentsRoutes(
  meController: WorkerDocumentsMeController,
  additionalMeController: WorkerAdditionalDocsMeController,
  adminAdditionalController: AdminAdditionalDocsController,
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
): Router {
  const router = Router();
  const auth = authMiddleware.requireAuth();
  const staffOnly = authMiddleware.requireStaff();
  const perm = permissions.family(ADMIN_WORKERS_FAMILY);

  // ── Worker self-service: fixed docs ─────────────────────────────────────
  router.get('/workers/me/documents', auth, (req: Request, res: Response) =>
    meController.getDocuments(req, res));
  router.post('/workers/me/documents/upload-url', auth, (req: Request, res: Response) =>
    meController.getUploadSignedUrl(req, res));
  router.post('/workers/me/documents/save', auth, (req: Request, res: Response) =>
    meController.saveDocumentPath(req, res));
  router.post('/workers/me/documents/view-url', auth, (req: Request, res: Response) =>
    meController.getViewSignedUrl(req, res));
  router.delete('/workers/me/documents/:type', auth, (req: Request, res: Response) =>
    meController.deleteDocument(req, res));

  // ── Worker self-service: additional docs ────────────────────────────────
  router.get('/workers/me/additional-documents', auth, (req: Request, res: Response) =>
    additionalMeController.list(req, res));
  router.post('/workers/me/additional-documents/upload-url', auth, (req: Request, res: Response) =>
    additionalMeController.getUploadUrl(req, res));
  router.post('/workers/me/additional-documents', auth, (req: Request, res: Response) =>
    additionalMeController.save(req, res));
  router.delete('/workers/me/additional-documents/:id', auth, (req: Request, res: Response) =>
    additionalMeController.remove(req, res));

  // ── Admin: additional docs ──────────────────────────────────────────────
  router.get('/admin/workers/:id/additional-documents', staffOnly, perm.require('worker_document', 'read'), (req: Request, res: Response) =>
    adminAdditionalController.list(req, res));
  router.post('/admin/workers/:id/additional-documents/upload-url', staffOnly, perm.require('worker_document', 'create'), (req: Request, res: Response) =>
    adminAdditionalController.getUploadUrl(req, res));
  router.post('/admin/workers/:id/additional-documents', staffOnly, perm.require('worker_document', 'create'), (req: Request, res: Response) =>
    adminAdditionalController.save(req, res));
  router.delete('/admin/workers/:id/additional-documents/:docId', staffOnly, perm.require('worker_document', 'delete'), (req: Request, res: Response) =>
    adminAdditionalController.remove(req, res));

  return router;
}
