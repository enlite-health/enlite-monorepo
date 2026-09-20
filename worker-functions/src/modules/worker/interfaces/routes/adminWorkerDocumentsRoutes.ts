import { Router, Request, Response } from 'express';
import { AdminWorkerDocumentsController } from '../controllers/AdminWorkerDocumentsController';
import { AuthMiddleware, type PermissionMiddleware } from '@modules/identity';
import { ADMIN_WORKERS_FAMILY } from './adminWorkerRoutes';

/**
 * Admin worker documents routes — /api/admin/workers/:id/documents/*
 * All endpoints require staff access.
 *
 * Parte da família `admin.workers` (task 3.5) — o nome vem de
 * `adminWorkerRoutes` de propósito: as 31 rotas de `/api/admin/workers/*`
 * moram em 4 arquivos e precisam virar JUNTAS quando entrarem em
 * `PERMISSION_ENFORCED_ROUTES`.
 *
 * `worker_document` é recurso SENSÍVEL (D-P4): aqui o acesso PERMITIDO também
 * vira linha na trilha, não só a negativa. É documento de identidade de gente.
 */
export function createAdminWorkerDocumentsRoutes(
  controller: AdminWorkerDocumentsController,
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
): Router {
  const router = Router();
  const staffOnly = authMiddleware.requireStaff();
  const perm = permissions.family(ADMIN_WORKERS_FAMILY);

  router.post('/workers/:id/documents/upload-url', staffOnly, perm.require('worker_document', 'create'), (req: Request, res: Response) =>
    controller.getUploadSignedUrl(req, res),
  );
  router.post('/workers/:id/documents/save', staffOnly, perm.require('worker_document', 'create'), (req: Request, res: Response) =>
    controller.saveDocumentPath(req, res),
  );
  router.post('/workers/:id/documents/view-url', staffOnly, perm.require('worker_document', 'read'), (req: Request, res: Response) =>
    controller.getViewSignedUrl(req, res),
  );
  router.delete('/workers/:id/documents/:type', staffOnly, perm.require('worker_document', 'delete'), (req: Request, res: Response) =>
    controller.deleteDocument(req, res),
  );
  router.post('/workers/:id/documents/:type/validate', staffOnly, perm.require('worker_document', 'validate'), (req: Request, res: Response) =>
    controller.validateDocument(req, res),
  );
  router.delete('/workers/:id/documents/:type/validate', staffOnly, perm.require('worker_document', 'validate'), (req: Request, res: Response) =>
    controller.invalidateDocument(req, res),
  );

  return router;
}
