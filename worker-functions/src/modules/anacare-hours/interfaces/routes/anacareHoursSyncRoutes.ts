import { Router, Request, Response } from 'express';
import { AuthMiddleware, type PermissionMiddleware } from '@modules/identity';
import { ADMIN_PATIENTS_FAMILY } from '@modules/identity/permissions';
import { AnaCareHoursSyncController } from '../controllers/AnaCareHoursSyncController';

/**
 * F4 (tasks 4.8/4.9) — DESENHO mínimo das duas entradas do "Sincronizar agora": botão (staff,
 * `/api/admin`) e Cloud Scheduler (`/api/internal`). As duas rotas chamam o MESMO
 * `AnaCareHoursSyncController` (mesma instância, injetada por quem monta o app em `index.ts`) —
 * é o que garante que o guard de dedup (4.8) enxerga as duas origens como uma coisa só.
 *
 * Célula reaproveitada de `anacareHoursRoutes.ts` (mesmo racional: domínio vizinho de paciente,
 * família nova está fora do escopo desta rodada).
 */
export function createAnaCareHoursSyncAdminRoutes(controller: AnaCareHoursSyncController, authMiddleware: AuthMiddleware, permissions: PermissionMiddleware): Router {
  const router = Router();
  const staffOnly = authMiddleware.requireStaff();
  const perm = permissions.family(ADMIN_PATIENTS_FAMILY);

  router.post('/anacare-hours/sync', staffOnly, perm.require('anacare_hours', 'validate'), (req: Request, res: Response) =>
    controller.triggerManual(req, res),
  );

  return router;
}

/** Montada em `/api/internal` (mesmo padrão de `internalRoutes.ts`: guard de secret/OIDC no `app.use`, não por rota). */
export function createAnaCareHoursSyncInternalRoutes(controller: AnaCareHoursSyncController): Router {
  const router = Router();

  router.post('/anacare-hours/sync', (req: Request, res: Response) => controller.triggerCron(req, res));

  return router;
}
