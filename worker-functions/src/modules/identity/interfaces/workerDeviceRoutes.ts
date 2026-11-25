import { Router, type Request, type RequestHandler, type Response } from 'express';
import type { AuthMiddleware } from './middleware/AuthMiddleware';
import type { PermissionMiddleware } from './middleware/PermissionMiddleware';
import { ADMIN_WORKERS_FAMILY, routeClass } from '@modules/identity/permissions';
import type { WorkerDeviceController } from './controllers/WorkerDeviceController';

/**
 * Aparelho da cuidadora (spec 077, D795). Dois routers:
 *
 * · SERVIÇO (`/v1`, montado no `index.ts`): o BFF registra o aparelho, lê o ativo e repassa a confirmação de apagamento.
 *   Guard OIDC + allowlist de SA, FAIL-CLOSED (`requireWorkerDeviceService`, injetado). Classe `service` declarada por `routeClass`.
 *
 * · STAFF (`/api/admin`): "Celular perdido" na ficha da cuidadora (POST revoke + GET status, a mesma célula). Família `admin.workers`, célula NOVA `worker_device:revoke`,
 *   LITERAL no `perm.require` (`celula-em-closure-nao-entra-no-catalogo`). `staffOnly` SEMPRE antes de `perm.require`.
 *   `untilEnforced: 'admin'`: enquanto a família não está enforced a rota fica restrita ao papel admin (nunca aberta a todo staff).
 *   Nenhum grupo recebe a célula por migration: quem a recebe é decisão dos C-levels.
 */
export function createWorkerDeviceServiceRoutes(serviceGuard: RequestHandler, controller: WorkerDeviceController): Router {
  const router = Router();
  const classeService = routeClass('service');
  router.post('/workers/:workerId/device', serviceGuard, classeService, (req: Request, res: Response) => controller.register(req, res));
  router.get('/workers/:workerId/device', serviceGuard, classeService, (req: Request, res: Response) => controller.get(req, res));
  router.post('/workers/:workerId/device/wiped', serviceGuard, classeService, (req: Request, res: Response) => controller.confirmWipe(req, res));
  return router;
}

export function createAdminWorkerDeviceRoutes(
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
  controller: WorkerDeviceController,
): Router {
  const router = Router();
  const staffOnly = authMiddleware.requireStaff();
  const perm = permissions.family(ADMIN_WORKERS_FAMILY);
  // Leitura do status com a MESMA célula do botão (quem pode pedir é quem vê o que pediu); nada de célula nova.
  router.get(
    '/workers/:workerId/device/status',
    staffOnly,
    perm.require('worker_device', 'revoke', { untilEnforced: 'admin' }),
    (req: Request, res: Response) => controller.status(req, res),
  );
  router.post(
    '/workers/:workerId/device/revoke',
    staffOnly,
    perm.require('worker_device', 'revoke', { untilEnforced: 'admin' }),
    (req: Request, res: Response) => controller.revoke(req, res),
  );
  return router;
}
