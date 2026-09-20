import { Router, Request, Response } from 'express';
import { AuthMiddleware, type PermissionMiddleware } from '@modules/identity';
import { ADMIN_PATIENTS_FAMILY } from '@modules/identity/permissions';
import { AnaCareHoursController } from '../controllers/AnaCareHoursController';

/**
 * Rotas da Conferência de horas do Ana Care (spec `anacare-conferencia-de-horas`, fase 1).
 * Montado em `/api/admin/anacare-hours`.
 *
 * Células (D344/D345 — distintas, fora de qualquer grupo padrão; descrição no mesmo commit,
 * ver `PermissionCell.ts` `CELL_DESCRIPTION`):
 *   · `anacare_hours:read`     — turnos, horas, origem, status (sem nome, sem nota).
 *   · `anacare_hours:validate` — validar, validar em lote, contestar.
 *
 * Família: reaproveita `admin.patients` (D344 não pede família PRÓPRIA — só célula própria; o
 * domínio é vizinho de paciente, mesmo molde do Projeto Terapêutico em
 * `adminTherapeuticProjectsRoutes.ts`). Família NOVA exigiria entrar nas 12 de
 * `ALL_PERMISSION_FAMILIES` e no e2e `permission-enforcement-all-families` — fora do escopo
 * aprovado desta fase (DIVERGÊNCIA registrada no fecho).
 */
export function createAnaCareHoursRoutes(controller: AnaCareHoursController, authMiddleware: AuthMiddleware, permissions: PermissionMiddleware): Router {
  const router = Router();
  const staffOnly = authMiddleware.requireStaff();
  const perm = permissions.family(ADMIN_PATIENTS_FAMILY);

  router.get(
    '/anacare-hours/months/:month',
    staffOnly,
    perm.require('anacare_hours', 'read'),
    (req: Request, res: Response) => controller.getMonthSnapshot(req, res),
  );
  router.get(
    '/anacare-hours/months/:month/patients/:patientId',
    staffOnly,
    perm.require('anacare_hours', 'read'),
    (req: Request, res: Response) => controller.getPatientMonth(req, res),
  );
  router.post(
    '/anacare-hours/shifts/validate-batch',
    staffOnly,
    perm.require('anacare_hours', 'validate'),
    (req: Request, res: Response) => controller.validateBatch(req, res),
  );
  router.post(
    '/anacare-hours/shifts/:shiftId/validate',
    staffOnly,
    perm.require('anacare_hours', 'validate'),
    (req: Request, res: Response) => controller.validateShift(req, res),
  );
  router.post(
    '/anacare-hours/shifts/:shiftId/contest',
    staffOnly,
    perm.require('anacare_hours', 'validate'),
    (req: Request, res: Response) => controller.contestShift(req, res),
  );

  return router;
}
