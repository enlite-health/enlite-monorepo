import { Router, Request, Response } from 'express';
import { WorkerDocumentsMeController } from '../controllers/WorkerDocumentsMeController';
import { WorkerAdditionalDocsMeController } from '../controllers/WorkerAdditionalDocsMeController';
import { AdminAdditionalDocsController } from '../controllers/AdminAdditionalDocsController';
import { AuthMiddleware, type PermissionMiddleware } from '@modules/identity';
import { ADMIN_WORKERS_FAMILY } from './adminWorkerRoutes';
import { routeClass } from '@modules/identity/permissions';

/**
 * Worker document routes — both self-service (/api/workers/me/documents)
 * and admin additional docs (/api/admin/workers/:id/additional-documents).
 *
 * ⚠️ Este arquivo tem os DOIS lados, e só um deles é decisão de staff. As 9
 * rotas `/workers/me/*` são do PRÓPRIO prestador sobre os PRÓPRIOS documentos:
 * classe `client-policy`, decididas pelo Cedar do cliente (`worker:read|update`
 * = `ReadOwnWorkerProfile|UpdateOwnWorkerProfile`, ficha própria `owner == principal`;
 * o recurso vem do token, não do cliente). Não entram na família `admin.workers`.
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
  // Documentos são parte da ficha do prestador (`worker`): mesma célula e mesma ação Cedar das rotas /workers/me da F2 (T311).
  const selfPerm = (action: 'read' | 'update') => authMiddleware.requirePermission('worker', action);

  // ── Worker self-service: fixed docs ─────────────────────────────────────
  router.get('/workers/me/documents', routeClass('client-policy'), auth, selfPerm('read'), (req: Request, res: Response) =>
    meController.getDocuments(req, res));
  router.post('/workers/me/documents/upload-url', routeClass('client-policy'), auth, selfPerm('update'), (req: Request, res: Response) =>
    meController.getUploadSignedUrl(req, res));
  router.post('/workers/me/documents/save', routeClass('client-policy'), auth, selfPerm('update'), (req: Request, res: Response) =>
    meController.saveDocumentPath(req, res));
  router.post('/workers/me/documents/view-url', routeClass('client-policy'), auth, selfPerm('read'), (req: Request, res: Response) =>
    meController.getViewSignedUrl(req, res));
  router.delete('/workers/me/documents/:type', routeClass('client-policy'), auth, selfPerm('update'), (req: Request, res: Response) =>
    meController.deleteDocument(req, res));

  // ── Worker self-service: additional docs ────────────────────────────────
  router.get('/workers/me/additional-documents', routeClass('client-policy'), auth, selfPerm('read'), (req: Request, res: Response) =>
    additionalMeController.list(req, res));
  router.post('/workers/me/additional-documents/upload-url', routeClass('client-policy'), auth, selfPerm('update'), (req: Request, res: Response) =>
    additionalMeController.getUploadUrl(req, res));
  router.post('/workers/me/additional-documents', routeClass('client-policy'), auth, selfPerm('update'), (req: Request, res: Response) =>
    additionalMeController.save(req, res));
  router.delete('/workers/me/additional-documents/:docId', routeClass('client-policy'), auth, selfPerm('update'), (req: Request, res: Response) =>
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
