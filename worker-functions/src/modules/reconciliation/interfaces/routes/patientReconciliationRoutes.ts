/**
 * patientReconciliationRoutes — monta o router da reconciliação (spec 003).
 *
 * Montado em src/bootstrap/registerAdminMaintenanceRoutes.ts como:
 *   app.use('/api/admin/patient-reconciliation', createPatientReconciliationRoutes(controller, authMiddleware));
 * Todas as rotas `requireAdmin()`. As duas fontes são lidas por API — não há upload.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { AuthMiddleware } from '@modules/identity';
import type { PatientReconciliationController } from '../controllers/PatientReconciliationController';

export function createPatientReconciliationRoutes(
  controller: PatientReconciliationController,
  authMiddleware: AuthMiddleware,
): Router {
  const router = Router();
  const adminOnly = authMiddleware.requireAdmin();
  const h = (fn: (req: Request, res: Response) => Promise<void> | void) =>
    (req: Request, res: Response) => { void fn.call(controller, req, res); };

  // ── H1 — fontes, rodadas, inventário ──────────────────────────────────────
  // CLICKUP saiu como fonte de snapshot (D314); só ANACARE tem reader.
  router.post('/runs/anacare', adminOnly, controller.snapshotSource('ANACARE'));
  router.get('/runs', adminOnly, h(controller.listRuns));
  router.get('/runs/:id', adminOnly, h(controller.getRun));
  router.get('/inventory', adminOnly, h(controller.inventory));
  router.get('/inventory/:set', adminOnly, h(controller.inventorySet));

  // ── H2-H5 — stubs 501 até T020/T024/T027 ──────────────────────────────────
  router.get('/items', adminOnly, h(controller.notImplemented));
  router.post('/patients/diff', adminOnly, h(controller.notImplemented));
  router.post('/items/:itemId/decide', adminOnly, h(controller.notImplemented));
  router.post('/bulk-rules', adminOnly, h(controller.notImplemented));
  router.delete('/bulk-rules/:ruleId', adminOnly, h(controller.notImplemented));
  router.post('/links/:linkId/confirm', adminOnly, h(controller.notImplemented));
  router.post('/links/:linkId/deny', adminOnly, h(controller.notImplemented));
  router.get('/history', adminOnly, h(controller.notImplemented));
  router.post('/apply', adminOnly, h(controller.notImplemented));

  return router;
}
