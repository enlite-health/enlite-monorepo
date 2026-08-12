import { Router, Request, Response } from 'express';
import { AuthMiddleware } from '@modules/identity';
import { AdminWorkersController } from '../controllers/AdminWorkersController';
import { AdminWorkersAuxController } from '../controllers/AdminWorkersAuxController';
import { AdminWorkerTestFlagController } from '../controllers/AdminWorkerTestFlagController';
import { AdminWorkerProfileController } from '../controllers/AdminWorkerProfileController';
import { AdminWorkerServiceAreaController } from '../controllers/AdminWorkerServiceAreaController';
import { AdminTagCatalogController } from '../controllers/AdminTagCatalogController';
import { WorkerTimelineController } from '../controllers/WorkerTimelineController';

export interface AdminWorkerRouteControllers {
  workers: AdminWorkersController;
  aux: AdminWorkersAuxController;
  testFlag: AdminWorkerTestFlagController;
  profile: AdminWorkerProfileController;
  serviceArea: AdminWorkerServiceAreaController;
  tags: AdminTagCatalogController;
  timeline: WorkerTimelineController;
}

/**
 * Admin worker + worker-tag routes — mounted at /api/admin.
 *
 * Route ordering is significant: specific paths (export, filter-options,
 * timeline) MUST precede the `/workers/:id` param route to avoid capture.
 */
export function createAdminWorkerRoutes(
  c: AdminWorkerRouteControllers,
  authMiddleware: AuthMiddleware,
): Router {
  const router = Router();
  const staffOnly = authMiddleware.requireStaff();
  const staffOrApiKey = authMiddleware.requireStaffOrApiKey();
  const adminOnly = authMiddleware.requireAdmin();

  // ── Admin Workers ──
  router.get('/workers/stats', staffOnly, (req: Request, res: Response) => c.aux.getWorkerDateStats(req, res));
  // by-phone aceita API key (consumido pelo triage-service pra resolver worker do contato)
  router.get('/workers/by-phone', staffOrApiKey, (req: Request, res: Response) => c.workers.getWorkerByPhone(req, res));
  router.get('/workers/case-options', staffOnly, (req: Request, res: Response) => c.aux.listCaseOptions(req, res));
  // filter-options MUST be before /:id to avoid param capture
  router.get('/workers/filter-options', staffOnly, (req: Request, res: Response) => c.aux.getFilterOptions(req, res));
  router.post('/workers/sync-talentum', staffOnly, (req: Request, res: Response) => c.aux.syncTalentumWorkers(req, res));
  // export MUST be registered before /:id to avoid param capture
  router.get('/workers/export', adminOnly, (req: Request, res: Response) => c.workers.exportWorkers(req, res));
  // timeline MUST be registered before /:id to avoid param capture
  router.get('/workers/:id/timeline', staffOnly, (req: Request, res: Response) => c.timeline.getTimeline(req, res));
  router.get('/workers/:id', staffOnly, (req: Request, res: Response) => c.workers.getWorkerById(req, res));
  // test-flag e profile são admin-only (mais estrito que staff)
  router.patch('/workers/:id/test-flag', adminOnly, (req: Request, res: Response) => c.testFlag.updateTestFlag(req, res));
  // edição de perfil do worker — apenas role ADMIN
  router.patch('/workers/:id/profile', adminOnly, (req: Request, res: Response) => c.profile.updateProfile(req, res));
  // edição de endereço/área de serviço — apenas role ADMIN (Google Places + lat/lng)
  router.put('/workers/:id/service-area', adminOnly, (req: Request, res: Response) => c.serviceArea.updateServiceArea(req, res));
  router.get('/workers', staffOnly, (req: Request, res: Response) => c.workers.listWorkers(req, res));

  // ── Worker Tags ──
  router.get('/worker-tags', staffOnly, (req: Request, res: Response) => c.tags.list(req, res));
  router.post('/worker-tags', adminOnly, (req: Request, res: Response) => c.tags.create(req, res));
  router.patch('/worker-tags/:id', adminOnly, (req: Request, res: Response) => c.tags.update(req, res));
  router.delete('/worker-tags/:id', adminOnly, (req: Request, res: Response) => c.tags.delete(req, res));
  router.post('/workers/:id/tags/:tagId', staffOnly, (req: Request, res: Response) => c.tags.assign(req, res));
  router.delete('/workers/:id/tags/:tagId', staffOnly, (req: Request, res: Response) => c.tags.remove(req, res));

  return router;
}
