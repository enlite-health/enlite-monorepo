import { Router, Request, Response } from 'express';
import { AuthMiddleware, type PermissionMiddleware } from '@modules/identity';
import { ADMIN_PATIENTS_FAMILY } from '@modules/identity/permissions';
import { logResourceAccess } from '@shared/audit/resourceAccessLog';
import { AdminDailyReportController } from '../controllers/AdminDailyReportController';
import { PgDailyReportAdminReader } from '../../infrastructure/PgDailyReportAdminReader';
import { GetPatientDailyReportsUseCase } from '../../application/dailyReport/GetPatientDailyReportsUseCase';
import { dailyReportTrailAction } from '../../application/dailyReportAccess';

export function buildAdminDailyReportController(): AdminDailyReportController {
  return new AdminDailyReportController(new GetPatientDailyReportsUseCase(new PgDailyReportAdminReader()));
}

/**
 * Leitura dos informes da guarda no painel (spec 092), na família `admin.patients` (sem família nova). Célula LITERAL na rota:
 *   · `daily_report:read` — a estrutura (data, prestador, respostas, notas, sinal, atraso).
 *   · `daily_report_narrative:read` — o TEXTO; decidida pelo use case com as células da request (sem ela: `narrative: null`, `narrativeRedacted: true`).
 * Trilha de leitura de paciente (`logResourceAccess`): a linha diz se o texto saiu (`…:narrative`) ou só a estrutura, sem dado.
 */
export function createAdminDailyReportRoutes(
  controller: AdminDailyReportController,
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
): Router {
  const router = Router();
  const staffOnly = authMiddleware.requireStaff();
  const perm = permissions.family(ADMIN_PATIENTS_FAMILY);

  router.get(
    '/patients/:patientId/daily-reports',
    staffOnly,
    perm.require('daily_report', 'read'),
    logResourceAccess('patient', (req: Request) => dailyReportTrailAction(req.permissionCells), (req: Request) => req.params.patientId),
    (req: Request, res: Response) => controller.list(req, res),
  );

  return router;
}
