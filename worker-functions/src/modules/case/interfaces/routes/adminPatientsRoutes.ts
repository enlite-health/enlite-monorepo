import { Router, Request, Response } from 'express';
import { AdminPatientsController } from '../controllers/AdminPatientsController';
import { AuthMiddleware } from '@modules/identity';

/**
 * Admin patients routes — mounted at /api/admin.
 * All endpoints require staff authentication (same pattern as /api/admin/workers).
 *
 * NOTE: /patients/stats must be registered BEFORE any future /patients/:id
 * route to avoid Express param capture.
 */
export function createAdminPatientsRoutes(
  controller: AdminPatientsController,
  authMiddleware: AuthMiddleware,
): Router {
  const router = Router();
  const staffOnly = authMiddleware.requireStaff();
  // test-flag e purge são admin-only (mais estrito que staff) — mesmo critério
  // do equivalente em workers. São ferramentas do synthetic monitoring.
  const adminOnly = authMiddleware.requireAdmin();

  // Static routes first (guard against future /:id capture)
  router.get('/patients/stats', staffOnly, (req: Request, res: Response) =>
    controller.getPatientStats(req, res),
  );

  // Funnel de conversão (Fase 4) — static, ANTES de /patients/:id.
  router.get('/patients/funnel', staffOnly, (req: Request, res: Response) =>
    controller.getPatientFunnel(req, res),
  );

  router.get('/patients', staffOnly, (req: Request, res: Response) =>
    controller.listPatients(req, res),
  );

  // Manual creation of a native patient (admission team). No :id in the path,
  // so it is safe here; POST does not collide with the GET /:id capture.
  router.post('/patients', staffOnly, (req: Request, res: Response) =>
    controller.createPatient(req, res),
  );

  // Dynamic route last — Express would capture /stats as /:id otherwise.
  router.get('/patients/:id', staffOnly, (req: Request, res: Response) =>
    controller.getPatientById(req, res),
  );

  // Patient addresses
  router.get('/patients/:patientId/addresses', staffOnly, (req: Request, res: Response) =>
    controller.listPatientAddresses(req, res),
  );
  router.post('/patients/:patientId/addresses', staffOnly, (req: Request, res: Response) =>
    controller.createPatientAddress(req, res),
  );

  // Patient vacancies — all job_postings for a patient, newest first
  router.get('/patients/:id/vacancies', staffOnly, (req: Request, res: Response) =>
    controller.listPatientVacancies(req, res),
  );

  // ── Write / lifecycle (Fase 2 Task 3) ──────────────────────────────────────
  // Literal-second-segment routes first (status, activate) so they read clearly;
  // they never collide with the addresses/vacancies routes (distinct methods or
  // distinct literal segments). The fully-dynamic PATCH /:id/:section goes LAST —
  // it is PATCH-only (no other PATCH route exists) and its :section is validated
  // against a hard whitelist (general|clinical|support-network|service).

  // PUT /patients/:id/status — kanban move (change lifecycle status)
  router.put('/patients/:id/status', staffOnly, (req: Request, res: Response) =>
    controller.updatePatientStatus(req, res),
  );

  // POST /patients/:id/activate — approve → generate one draft vacancy per location
  router.post('/patients/:id/activate', staffOnly, (req: Request, res: Response) =>
    controller.activatePatient(req, res),
  );

  // ── Synthetic monitoring (e2e-prod) ────────────────────────────────────────
  // Literais ANTES do PATCH dinâmico /:id/:section — senão 'test-flag' seria
  // capturado como :section e barrado pelo whitelist.
  router.patch('/patients/:id/test-flag', adminOnly, (req: Request, res: Response) =>
    controller.updatePatientTestFlag(req, res),
  );
  // Purga só de paciente is_test (real → 409). Ver PatientTestFixtureService.
  router.delete('/patients/:id', adminOnly, (req: Request, res: Response) =>
    controller.purgeTestPatient(req, res),
  );

  // PATCH /patients/:id/:section — section-scoped partial edit (last: fully dynamic)
  router.patch('/patients/:id/:section', staffOnly, (req: Request, res: Response) =>
    controller.updatePatientSection(req, res),
  );

  return router;
}
