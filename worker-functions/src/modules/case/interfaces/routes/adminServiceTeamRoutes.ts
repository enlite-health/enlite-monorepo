import { Router, Request, Response } from 'express';
import { AuthMiddleware, type PermissionMiddleware } from '@modules/identity';
import { ADMIN_PATIENTS_FAMILY } from '@modules/identity/permissions';
import { AdminServiceTeamController } from '../controllers/AdminServiceTeamController';

/**
 * Rotas do quadro C (Servicio Contratado) — cadeia Fase 10, DX-10.7. Router PRÓPRIO (ressalva
 * (a'): `adminPatientsRoutes.ts` tem 398 linhas, teto 400 — 3 rotas + 1 parâmetro de fábrica não
 * cabem), montado em `/api/admin`, na família `admin.patients` já existente (D299.3, sem família
 * nova). `:sid` (não `:serviceId`): o nome das rotas irmãs do mesmo recurso
 * (`adminPatientsRoutes.ts:259,268,275,278`) — Q-EX-10.3.
 *
 * Célula (DX-10.1): leitura sob `patient_services:read` (a mesma do itinerário e do agregado do
 * Kanban); as duas escritas sob `patient_service_team:update` — **nunca** `:write`
 * (`permission-route-create-update-fixture.test.ts` reprova `:write` fora de
 * `permission_management`). Sem `countryScope` (a RLS decide, como as irmãs por `:id`); sem
 * `logResourceAccess` — a trilha de contato é a do `AdminServiceTeamController`
 * (`emitirTrilhaDeContato`, DX-10.6). **Nenhum** `router.put|patch|delete`, nenhum POST de
 * "adicionar" (invariante 1, critério 5 → exatamente duas chamadas de `router.post`).
 */
export function createAdminServiceTeamRoutes(
  controller: AdminServiceTeamController,
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
): Router {
  const router = Router();
  const staffOnly = authMiddleware.requireStaff();
  const perm = permissions.family(ADMIN_PATIENTS_FAMILY);

  router.get(
    '/patients/:id/contracted-services/:sid/team',
    staffOnly,
    perm.require('patient_services', 'read'),
    (req: Request, res: Response) => controller.get(req, res),
  );
  router.post(
    '/patients/:id/contracted-services/:sid/team/reject',
    staffOnly,
    perm.require('patient_service_team', 'update'),
    (req: Request, res: Response) => controller.reject(req, res),
  );
  router.post(
    '/patients/:id/contracted-services/:sid/team/revert',
    staffOnly,
    perm.require('patient_service_team', 'update'),
    (req: Request, res: Response) => controller.revert(req, res),
  );

  return router;
}
