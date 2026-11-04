import { Router, Request, Response } from 'express';
import { AuthMiddleware, type PermissionMiddleware } from '@modules/identity';
import { ADMIN_PATIENTS_FAMILY } from '@modules/identity/permissions';
import { AdminItineraryChangesController } from '../controllers/AdminItineraryChangesController';

/**
 * Rota de leitura do registro de trocas do itinerário (C9, change itinerario-trocas-motivos-e-figma,
 * Fase 2). Router PRÓPRIO: o router de leitura do itinerário (`adminPatientsRoutes.ts`) já passa do
 * teto de 400 linhas, e o de escrita (`adminItineraryWriteRoutes.ts`) tem contagem de `router.get`
 * travada por teste. Molde: `adminItineraryWriteRoutes.ts`. Montado em `/api/admin`, família
 * `admin.patients` existente (sem família nova).
 *
 * Célula `patient_services:read` (a mesma do GET do itinerário); `perm.require` no ARRAY da rota,
 * nunca em closure (memória `celula-em-closure-nao-entra-no-catalogo`). Exatamente 1 `router.get(`,
 * 0 escritas.
 */
export function createAdminItineraryChangesRoutes(
  controller: AdminItineraryChangesController,
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
): Router {
  const router = Router();
  const staffOnly = authMiddleware.requireStaff();
  const perm = permissions.family(ADMIN_PATIENTS_FAMILY);

  router.get(
    '/patients/:id/contracted-services/:sid/itinerary/changes',
    staffOnly,
    perm.require('patient_services', 'read'),
    (req: Request, res: Response) => controller.list(req, res),
  );

  return router;
}
