import { Router, Request, Response } from 'express';
import { AuthMiddleware, type PermissionMiddleware } from '@modules/identity';
import { ADMIN_PATIENTS_FAMILY } from '@modules/identity/permissions';
import { AdminSubstitutionRequestController } from '../controllers/AdminSubstitutionRequestController';

/**
 * Rotas do pedido de substituição (spec 069, §3.3). Router PRÓPRIO: `adminItineraryWriteRoutes.ts` está no teto e o controller
 * dele já tem 409 linhas. Montado em `/api/admin`, família `ADMIN_PATIENTS_FAMILY` (sem família nova, nenhuma célula nova):
 *  - leituras (lista Próximas/Pasadas, pessoas que podem "não vir") sob `patient_services:read`;
 *  - pré-visão (LEITURA, mas por POST: o corpo leva candidatos × período) e criação sob `patient_itinerary:update` — a célula
 *    das escritas do itinerário; **nunca** `:write`.
 * `perm.require` sempre no ARRAY da rota, nunca em closure (memória `celula-em-closure-nao-entra-no-catalogo`). Sem `countryScope`
 * (a RLS decide, como as irmãs por `:id`). Desfazer (`:rid/undo`) e "Elegir quién entra" (`:rid/cover`) — F3 — também sob `patient_itinerary:update`.
 */
export function createAdminSubstitutionRequestRoutes(
  controller: AdminSubstitutionRequestController,
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
): Router {
  const router = Router();
  const staffOnly = authMiddleware.requireStaff();
  const perm = permissions.family(ADMIN_PATIENTS_FAMILY);
  const base = '/patients/:id/contracted-services/:sid/substitution-requests';

  router.get(base, staffOnly, perm.require('patient_services', 'read'), (req: Request, res: Response) => controller.list(req, res));
  router.get(`${base}/outgoing-options`, staffOnly, perm.require('patient_services', 'read'), (req: Request, res: Response) =>
    controller.outgoingOptions(req, res),
  );
  router.post(`${base}/preview`, staffOnly, perm.require('patient_itinerary', 'update'), (req: Request, res: Response) =>
    controller.preview(req, res),
  );
  router.post(base, staffOnly, perm.require('patient_itinerary', 'update'), (req: Request, res: Response) => controller.create(req, res));
  router.post(`${base}/:rid/undo`, staffOnly, perm.require('patient_itinerary', 'update'), (req: Request, res: Response) => controller.undo(req, res));
  router.post(`${base}/:rid/cover`, staffOnly, perm.require('patient_itinerary', 'update'), (req: Request, res: Response) => controller.cover(req, res));

  return router;
}
