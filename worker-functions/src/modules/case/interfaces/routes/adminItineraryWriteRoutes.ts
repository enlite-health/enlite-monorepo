import { Router, Request, Response } from 'express';
import { AuthMiddleware, type PermissionMiddleware } from '@modules/identity';
import { ADMIN_PATIENTS_FAMILY } from '@modules/identity/permissions';
import { AdminItineraryWriteController } from '../controllers/AdminItineraryWriteController';
import { AdminItineraryAbsenceController } from '../controllers/AdminItineraryAbsenceController';

/**
 * Rotas dos 10 escritores do itinerário — cadeia Fase 11 (7) + Fase 13 (3, DX-13.8: a substituição
 * pontual). Router PRÓPRIO (mesma razão do quadro C: `adminPatientsRoutes.ts` tem 398 linhas, teto
 * 400 — as 10 rotas não cabem), montado em `/api/admin`, na família `admin.patients` já existente
 * (D299.3, sem família nova).
 *
 * Célula (DX-11.1/DX-13.8): leitura (`allocation-options`) sob `patient_services:read` (a MESMA do
 * GET do itinerário e do quadro C); as 9 escritas — as 6 da Fase 11 e as 3 novas da ausência — sob
 * `patient_itinerary:update` — **nunca** `:write` (`permission-route-create-update-fixture.test.ts`
 * reprova `:write` fora de `permission_management`). `perm.require` sempre no ARRAY da rota, nunca
 * em closure (memória `celula-em-closure-nao-entra-no-catalogo`). Sem `countryScope` (a RLS decide,
 * como as irmãs por `:id`); sem `logResourceAccess` — a trilha de contato é a do
 * `AdminItineraryWriteController` (`emitirTrilhaDeContato`, DX-11.10; a ausência não tem trilha —
 * nenhum nome sai dela). Exatamente 1 `router.get(`, 2 `router.patch(`, 7 `router.post(`, 0
 * `router.put|delete(`.
 */
export function createAdminItineraryWriteRoutes(
  controller: AdminItineraryWriteController,
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
  absenceController: AdminItineraryAbsenceController = new AdminItineraryAbsenceController(),
): Router {
  const router = Router();
  const staffOnly = authMiddleware.requireStaff();
  const perm = permissions.family(ADMIN_PATIENTS_FAMILY);

  router.get(
    '/patients/:id/contracted-services/:sid/allocation-options',
    staffOnly,
    perm.require('patient_services', 'read'),
    (req: Request, res: Response) => controller.allocationOptions(req, res),
  );
  router.post(
    '/patients/:id/contracted-services/:sid/itinerary/slots',
    staffOnly,
    perm.require('patient_itinerary', 'update'),
    (req: Request, res: Response) => controller.createSlot(req, res),
  );
  router.patch(
    '/patients/:id/contracted-services/:sid/itinerary/slots/:slotId',
    staffOnly,
    perm.require('patient_itinerary', 'update'),
    (req: Request, res: Response) => controller.updateSlot(req, res),
  );
  router.post(
    '/patients/:id/contracted-services/:sid/itinerary/slots/:slotId/end',
    staffOnly,
    perm.require('patient_itinerary', 'update'),
    (req: Request, res: Response) => controller.endSlot(req, res),
  );
  router.post(
    '/patients/:id/contracted-services/:sid/itinerary/slots/:slotId/allocations',
    staffOnly,
    perm.require('patient_itinerary', 'update'),
    (req: Request, res: Response) => controller.allocate(req, res),
  );
  router.post(
    '/patients/:id/contracted-services/:sid/itinerary/allocations/:allocationId/end',
    staffOnly,
    perm.require('patient_itinerary', 'update'),
    (req: Request, res: Response) => controller.endAllocation(req, res),
  );
  router.post(
    '/patients/:id/itinerary/assemble',
    staffOnly,
    perm.require('patient_itinerary', 'update'),
    (req: Request, res: Response) => controller.assemble(req, res),
  );
  router.post(
    '/patients/:id/contracted-services/:sid/itinerary/allocations/:allocationId/absences',
    staffOnly,
    perm.require('patient_itinerary', 'update'),
    (req: Request, res: Response) => absenceController.register(req, res),
  );
  router.patch(
    '/patients/:id/contracted-services/:sid/itinerary/absences/:absenceId/substitute',
    staffOnly,
    perm.require('patient_itinerary', 'update'),
    (req: Request, res: Response) => absenceController.setSubstitute(req, res),
  );
  router.post(
    '/patients/:id/contracted-services/:sid/itinerary/absences/:absenceId/cancel',
    staffOnly,
    perm.require('patient_itinerary', 'update'),
    (req: Request, res: Response) => absenceController.cancel(req, res),
  );

  return router;
}
