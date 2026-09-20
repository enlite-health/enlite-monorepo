/**
 * patientReconciliationRoutes — monta o router da reconciliação (spec 003).
 *
 * Montado em src/bootstrap/registerAdminMaintenanceRoutes.ts como:
 *   app.use('/api/admin/patient-reconciliation', createPatientReconciliationRoutes(controller, authMiddleware, permissions));
 * As duas fontes são lidas por API — não há upload.
 *
 * ⚠️ MERGE main→stage 19/09/2026: este arquivo veio da `main` chamando
 * `authMiddleware.requireAdmin()`, que não existe mais na `stage` — o papel de
 * usuário morreu (D294/07-09) e virou célula ABAC (`PermissionMiddleware`).
 * Troquei para `requireStaff()` + `perm.require(resource, action, { untilEnforced:
 * 'admin' })`, o MESMO mecanismo que `adminPatientsRoutes.ts`/`dedupRoutes.ts`/
 * `testFixturesRoutes.ts` usam para migrar rota de `requireAdmin()` — o comentário
 * de `PermissionMiddleware.passUntilEnforced` é explícito: com `'admin'` a
 * resposta é IDÊNTICA à do `requireAdmin()` de antes (checa `EnliteRole.ADMIN`)
 * enquanto a família não estiver em `PERMISSION_ENFORCED_ROUTES` — não afrouxei
 * nada.
 *
 * Família reaproveitada: `ADMIN_PATIENTS_FAMILY` — não inventei família nova.
 * O recurso é `patient` porque `GET /inventory/:set` devolve nome/nascimento do
 * paciente (mesmo dossiê que `GET /patients/:id` protege com `patient:read` em
 * `adminPatientsRoutes.ts`), e o módulo inteiro reconcilia registro de PACIENTE
 * entre fontes — não há recurso irmão mais específico ainda catalogado. Ação por
 * verbo HTTP, no mesmo padrão das rotas irmãs: GET→read, POST que cria
 * linha nova (rodada de snapshot, regra em massa)→create, POST/PATCH que
 * decide/confirma algo que já existe→update, DELETE→delete. Isto NÃO foi
 * validado com o mapa formal da spec 003 (o módulo ainda não é montado em
 * nenhum bootstrap) — quando for mapeado oficialmente, conferir contra
 * `route-permission-map.md` da change e ajustar se divergir.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { AuthMiddleware, PermissionMiddleware } from '@modules/identity';
import { ADMIN_PATIENTS_FAMILY } from '@modules/identity/permissions';
import type { PatientReconciliationController } from '../controllers/PatientReconciliationController';

export function createPatientReconciliationRoutes(
  controller: PatientReconciliationController,
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
): Router {
  const router = Router();
  const staffOnly = authMiddleware.requireStaff();
  const perm = permissions.family(ADMIN_PATIENTS_FAMILY);
  const adminOnly = (resource: string, action: string) =>
    [staffOnly, perm.require(resource, action, { untilEnforced: 'admin' })] as const;
  const h = (fn: (req: Request, res: Response) => Promise<void> | void) =>
    (req: Request, res: Response) => { void fn.call(controller, req, res); };

  // ── H1 — fontes, rodadas, inventário ──────────────────────────────────────
  // CLICKUP saiu como fonte de snapshot (D314); só ANACARE tem reader.
  router.post('/runs/anacare', ...adminOnly('patient', 'create'), controller.snapshotSource('ANACARE'));
  router.get('/runs', ...adminOnly('patient', 'read'), h(controller.listRuns));
  router.get('/runs/:id', ...adminOnly('patient', 'read'), h(controller.getRun));
  router.get('/inventory', ...adminOnly('patient', 'read'), h(controller.inventory));
  router.get('/inventory/:set', ...adminOnly('patient', 'read'), h(controller.inventorySet));

  // ── H2-H5 — stubs 501 até T020/T024/T027 ──────────────────────────────────
  router.get('/items', ...adminOnly('patient', 'read'), h(controller.notImplemented));
  router.post('/patients/diff', ...adminOnly('patient', 'read'), h(controller.notImplemented));
  router.post('/items/:itemId/decide', ...adminOnly('patient', 'update'), h(controller.notImplemented));
  router.post('/bulk-rules', ...adminOnly('patient', 'create'), h(controller.notImplemented));
  router.delete('/bulk-rules/:ruleId', ...adminOnly('patient', 'delete'), h(controller.notImplemented));
  router.post('/links/:linkId/confirm', ...adminOnly('patient', 'update'), h(controller.notImplemented));
  router.post('/links/:linkId/deny', ...adminOnly('patient', 'update'), h(controller.notImplemented));
  router.get('/history', ...adminOnly('patient', 'read'), h(controller.notImplemented));
  router.post('/apply', ...adminOnly('patient', 'update'), h(controller.notImplemented));

  return router;
}
