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

  // Static routes first (guard against future /:id capture)
  router.get('/patients/stats', staffOnly, (req: Request, res: Response) =>
    controller.getPatientStats(req, res),
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

  return router;
}
