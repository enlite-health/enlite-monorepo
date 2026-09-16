import { Router, Request, Response } from 'express';
import { AuthMiddleware } from '@modules/identity';
import { AnaCareHoursController } from '../controllers/AnaCareHoursController';
import { requireAnaCareHoursAllowlist } from '../middleware/requireAnaCareHoursAllowlist';

/**
 * Rotas da Conferência de horas do Ana Care (spec `anacare-conferencia-de-horas`, fase 1).
 * Montado em `/api/admin/anacare-hours`.
 *
 * PORTADA para o `main` sem o engine ABAC (só existe na `stage`): as células `anacare_hours:read`/
 * `anacare_hours:validate` da stage viram, aqui, uma allowlist de e-mail única
 * (`requireAnaCareHoursAllowlist`) — mesma allowlist para leitura e escrita, sem a granularidade
 * fina da stage. Ver comentário do middleware para o porquê.
 */
export function createAnaCareHoursRoutes(controller: AnaCareHoursController, authMiddleware: AuthMiddleware): Router {
  const router = Router();
  const staffOnly = authMiddleware.requireStaff();
  const allowlisted = requireAnaCareHoursAllowlist();

  router.get(
    '/anacare-hours/months/:month',
    staffOnly,
    allowlisted,
    (req: Request, res: Response) => controller.getMonthSnapshot(req, res),
  );
  router.get(
    '/anacare-hours/months/:month/patients/:patientId',
    staffOnly,
    allowlisted,
    (req: Request, res: Response) => controller.getPatientMonth(req, res),
  );
  router.post(
    '/anacare-hours/shifts/validate-batch',
    staffOnly,
    allowlisted,
    (req: Request, res: Response) => controller.validateBatch(req, res),
  );
  router.post(
    '/anacare-hours/shifts/:shiftId/validate',
    staffOnly,
    allowlisted,
    (req: Request, res: Response) => controller.validateShift(req, res),
  );
  router.post(
    '/anacare-hours/shifts/:shiftId/contest',
    staffOnly,
    allowlisted,
    (req: Request, res: Response) => controller.contestShift(req, res),
  );

  return router;
}
