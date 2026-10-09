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
 *  - `patient_admission:write`          — hosts do roster, agendar, cancelar.
 *  - `patient_admission:resend_message` — reenviar o WhatsApp que falhou.
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
    perm.require('patient_admission', 'write', { untilEnforced: 'admin' }),
    (req: Request, res: Response) => controller.listHosts(req, res),
  );

  router.post(
    '/patients/:id/admission-appointments',
    staffOnly,
    perm.require('patient_admission', 'write', { untilEnforced: 'admin' }),
    (req: Request, res: Response) => controller.book(req, res),
  );

  router.post(
    '/patients/:id/admission-appointments/:apptId/cancel',
    staffOnly,
    perm.require('patient_admission', 'write', { untilEnforced: 'admin' }),
    (req: Request, res: Response) => controller.cancel(req, res),
  );

  router.post(
    '/patients/:id/admission-appointments/:apptId/messages/:kind/resend',
    staffOnly,
    perm.require('patient_admission', 'resend_message', { untilEnforced: 'admin' }),
    (req: Request, res: Response) => controller.resend(req, res),
  );

  return router;
}
