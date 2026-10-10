import { Router, Request, Response } from 'express';
import { AuthMiddleware, type PermissionMiddleware } from '@modules/identity';
import { ADMIN_PATIENTS_FAMILY } from '@modules/identity/permissions';
import { AdmissionPanelController } from '../controllers/AdmissionPanelController';

/**
 * Rotas da aba "Admissão" do paciente (spec 049 F3). Montadas sob `/api/admin`, família `admin.patients`
 * (molde `patientDocumentsRoutes.ts`).
 *
 * Células LITERAIS em cada rota (nunca por variável/loop/closure — o scanner do catálogo só reconhece
 * `perm.require('recurso', 'ação', ...)` com strings literais; `celula-em-closure-nao-entra-no-catalogo`):
 *  - `patient_admission:read`           — lista de reuniões (site + painel) com os selos.
 *  - `patient_admission:create`         — hosts do roster e agendar.
 *  - `patient_admission:update`         — cancelar a agenda (convenção PR-8b: `write` não existe fora de permission_management).
 *  - `patient_admission:resend_message` — reenviar o WhatsApp que falhou.
 *  - `patient_admission:release_paid_rehearsal` — liberar o ensaio pago de UMA reunião de teste por 48 h (spec 050 R-19; só Master).
 * `untilEnforced: 'admin'`: com a família ainda não enforçada, só o papel admin passa.
 * `staffOnly` SEMPRE antes de `perm.require` (a ordem é parte do contrato do `PermissionMiddleware`).
 */
export function createAdminAdmissionRoutes(
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
  controller: AdmissionPanelController,
): Router {
  const router = Router();
  const staffOnly = authMiddleware.requireStaff();
  const perm = permissions.family(ADMIN_PATIENTS_FAMILY);

  router.get(
    '/patients/:id/admission-appointments',
    staffOnly,
    perm.require('patient_admission', 'read', { untilEnforced: 'admin' }),
    (req: Request, res: Response) => controller.list(req, res),
  );

  router.get(
    '/admission/hosts',
    staffOnly,
    perm.require('patient_admission', 'create', { untilEnforced: 'admin' }),
    (req: Request, res: Response) => controller.listHosts(req, res),
  );

  router.post(
    '/patients/:id/admission-appointments',
    staffOnly,
    perm.require('patient_admission', 'create', { untilEnforced: 'admin' }),
    (req: Request, res: Response) => controller.book(req, res),
  );

  router.post(
    '/patients/:id/admission-appointments/:apptId/cancel',
    staffOnly,
    perm.require('patient_admission', 'update', { untilEnforced: 'admin' }),
    (req: Request, res: Response) => controller.cancel(req, res),
  );

  router.post(
    '/patients/:id/admission-appointments/:apptId/messages/:kind/resend',
    staffOnly,
    perm.require('patient_admission', 'resend_message', { untilEnforced: 'admin' }),
    (req: Request, res: Response) => controller.resend(req, res),
  );

  router.post(
    '/patients/:id/admission-appointments/:apptId/paid-rehearsal',
    staffOnly,
    perm.require('patient_admission', 'release_paid_rehearsal', { untilEnforced: 'admin' }),
    (req: Request, res: Response) => controller.releasePaidRehearsal(req, res),
  );

  return router;
}
